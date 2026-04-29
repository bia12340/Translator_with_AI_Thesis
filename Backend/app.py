import os
import uuid
import uvicorn
import requests
from supabase import create_client, Client
import hashlib
import secrets
from fastapi import FastAPI, UploadFile, File, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from gtts import gTTS
from fastapi.responses import FileResponse
from groq import Groq # Importăm clientul Groq
from fastapi import BackgroundTasks, Header
import json
import asyncio
from dotenv import load_dotenv

load_dotenv() # Aceasta linie cauta fisierul .env si incarca cheia

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

# Aceasta este variabila prin care codul tău va vorbi cu baza de date
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
print("[✓] Conexiune Supabase inițializată")

# --- Startup Cleanup for Orphaned Audio Files ---
def cleanup_audio_files():
    patterns = ["tts_", "temp_"]
    exts = [".mp3", ".wav"]
    for fname in os.listdir('.'):
        for p in patterns:
            for e in exts:
                if fname.startswith(p) and fname.endswith(e):
                    try:
                        os.remove(fname)
                        print(f"[CLEANUP] Deleted leftover file: {fname}")
                    except Exception as err:
                        print(f"[CLEANUP] Failed to delete {fname}: {err}")

cleanup_audio_files()

app = FastAPI()
auth_sessions = {}

# Permitem accesul de la frontend-ul tău local
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"] # Aceasta linie ajută browserul să vadă fișierul audio
)

# Inițializăm Groq (se va citi din variabila de mediu pe HF sau local)
client = Groq(api_key=os.getenv("GROQ_API_KEY"))  # Asigură-te că ai setat variabila de mediu GROQ_API_KEY
print("[✓] Groq client inițializat cu succes")

# Memoria conversației per utilizator (stochează ultimele 10 replici per user)
user_chat_histories = {}

def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt),
        120000
    ).hex()

def normalize_lang_code(lang: str):
    lang = (lang or "").strip().lower()
    if not lang:
        return None
    if len(lang) < 2:
        return None
    return lang[:2]

def create_user(username: str, email: str, password: str, main_language: str = ""):
    username = (username or "").strip()
    email = (email or "").strip().lower()
    if len(username) < 3:
        return False, "Username-ul trebuie să aibă cel puțin 3 caractere"
    if "@" not in email:
        return False, "Email invalid"
    if len(password or "") < 6:
        return False, "Parola trebuie să aibă cel puțin 6 caractere"
    main_lang = normalize_lang_code(main_language)

    salt = secrets.token_hex(16)
    password_hash = hash_password(password, salt)
    try:
        user_data = {
            "username": (username or "").strip(),
            "email": (email or "").strip().lower(),
            "password_hash": password_hash,
            "salt": salt,
            "main_language": normalize_lang_code(main_language)
        }
        supabase.table("users").insert(user_data).execute()
        return True, None
    except Exception as e:
        error_msg = str(e)
        print(f"[✗] Eroare reală Supabase: {error_msg}")
        # Daca eroarea contine "already exists", stim ca e duplicat, altfel e alta problema
        if "already exists" in error_msg.lower():
            return False, "Username sau email deja există"
        return False, f"Eroare tehnică: {error_msg}"

def verify_user(email: str, password: str):
    email = (email or "").strip().lower()
    
    # Căutăm utilizatorul după email în Supabase
    response = supabase.table("users").select("*").eq("email", email).execute()
    
    if not response.data:
        return None

    user = response.data[0]
    # Verificăm parola folosind hash-ul salvat
    if hash_password(password, user["salt"]) != user["password_hash"]:
        return None

    return {
        "id": user["id"], 
        "username": user["username"], 
        "email": user["email"], 
        "main_language": user["main_language"]
    }

def update_user_main_language(user_id: int, main_language: str):
    main_lang = normalize_lang_code(main_language)
    try:
        supabase.table("users").update({"main_language": main_lang}).eq("id", user_id).execute()
        return main_lang
    except Exception as e:
        print(f"[✗] Eroare update limbă Supabase: {e}")
        return main_lang

def get_user_from_token(token: str):
    if not token:
        return None
    return auth_sessions.get(token)

def save_history_entries(user_id: int, entries: list):
    print(f"[*] save_history_entries apelat pentru user {user_id}. Primite {len(entries) if entries else 0} intrări.")
    if not entries:
        return
    
    try:
        supabase_rows = []
        for entry in entries:
            # Extragem datele cu mare atenție la nume
            row = {
                "user_id": user_id,
                "session_id": str(entry.get("session_id") or uuid.uuid4()),
                "client_entry_id": str(entry.get("client_entry_id") or uuid.uuid4()),
                "source_lang": str(entry.get("source_lang") or "auto"),
                "target_lang": str(entry.get("target_lang") or "en"),
                "original_text": str(entry.get("original_text") or "").strip(),
                "translated_text": str(entry.get("translated_text") or "").strip()
            }
            supabase_rows.append(row)

        if supabase_rows:
            # Folosim upsert pentru a evita erori de duplicare
            result = supabase.table("translation_history").upsert(supabase_rows).execute()
            print(f"[✓] SUCCES: {len(supabase_rows)} rânduri salvate în Supabase.")
    except Exception as e:
        print(f"[✗] EROARE CRITICĂ la salvarea în Supabase: {e}")

def query_google_translate(text, target_lang="en"):
    """Traducere folosind Google Translate API (v1 neoficial)"""
    print(f"[*] Traducere: '{text[:50]}...' -> {target_lang}")
    try:
        url = "https://translate.googleapis.com/translate_a/single"
        params = {
            "client": "gtx",
            "sl": "auto", 
            "tl": target_lang,
            "dt": "t",
            "q": text
        }
        response = requests.get(url, params=params, timeout=5)
        print(f"[*] Status code Google Translate: {response.status_code}")
        if response.status_code == 200:
            result = response.json()[0][0][0]
            print(f"[✓] Traducere reușită: '{result[:50]}...'")
            return result
        error_msg = f"Eroare API: {response.status_code}"
        print(f"[✗] {error_msg}")
        return error_msg
    except Exception as e:
        error_msg = f"Eroare conexiune: {str(e)}"
        print(f"[✗] {error_msg}")
        return error_msg

def ai_agent_process(text, user="default", use_memory=True, default_target_lang="en"):

    global user_chat_histories

    if user not in user_chat_histories:
        user_chat_histories[user] = []

    try:

        # Construim mesajele incluzând istoricul

        messages = [

            {

                "role": "system",

                "content": """Ești un motor de traducere PRECISE cu detecție automată a limbii țintă.

                SARCINA TA EXACTĂ:
                1. Analizează cererea utilizatorului.
                2. Identifică LIMBA ȚINTĂ și TEXTUL de tradus.
                3. DETERMINĂ CODUL ISO 639-1 CORECT al limbii țintă (en, ro, es, fr, de, it, pt, zh, ja, ko, ru, ar, etc.)
                4. TRADUCE textul ÎN ACEA LIMBĂ.
                5. Returnează NUMAI JSON: {"text": "traducerea_exacta", "source_lang": "cod_sursa", "target_lang": "cod_tinta"}

                EXEMPLE DE CERERI ȘI RĂSPUNSURI CORECTE:
                
                INPUT: "Tradu asta în engleza: Salut cum ești?"  
                OUTPUT: {"text": "Hello, how are you?", "source_lang": "ro", "target_lang": "en"}
                
                INPUT: "Translate into Spanish I care about you"  
                OUTPUT: {"text": "Me importas mucho", "source_lang": "en", "target_lang": "es"}
                
                INPUT: "Tradu în romana: Hello world"  
                OUTPUT: {"text": "Salut lume", "source_lang": "en", "target_lang": "ro"}
                
                INPUT: "Traduc în limba franceză vreau să merg la mare"  
                OUTPUT: {"text": "Je veux aller à la mer", "source_lang": "ro", "target_lang": "fr"}
                
                INPUT: "Translate into Mandarin Chinese I want ice cream"  
                OUTPUT: {"text": "我想要冰淇淋", "source_lang": "en", "target_lang": "zh"}

                REGULI STRICTE:
                - CODUL LIMBII TREBUIE SĂ FIE ISO 639-1 CORECT: "en", "ro", "es", "fr", "de", "it", "pt", "zh", "ja", "ko", "ru", "ar", "pl", "nl", "tr", "vi", "th", "hi", etc.
                - NU TRADUCE COMANDA, traduce DOAR TEXTUL.
                - NU ADĂUGA explicații, comentarii sau alt text.
                - Răspunsul trebuie să fie STRICT JSON valid.
                - Cheia "text" = traducerea completă
                - Cheia "source_lang" = codul ISO 639-1 al limbii sursă
                - Cheia "target_lang" = codul ISO 639-1 al limbii țintă
                - Dacă nu-i clar ce limbă dorește, folosește limba default "{default_target_lang}".
                - Dacă textul include explicit "translate into X" / "tradu în X", urmează explicit X.
                """

            }

        ]

       

        # ⚡ Opțional adăugăm context anterior
        if use_memory and len(user_chat_histories[user]) > 0:
            messages.extend(user_chat_histories[user][-2:])

       

        # Adăugăm replica curentă

        messages.append({"role": "user", "content": text})

        print(f"[*] Trimit la Groq: {len(messages)} mesaje (cu 2 replici context max), ultim text: {text[:50]}...")

        chat_completion = client.chat.completions.create(

            messages=messages,

            model="llama-3.3-70b-versatile",

            response_format={"type": "json_object"},
            temperature=0.3  # Mai scăzută pentru răspunsuri mai consistente

        )

        response_text = chat_completion.choices[0].message.content
        print(f"[*] Raw Groq response: {response_text[:200]}")
        
        # Validare JSON
        try:
            result = json.loads(response_text)
            print(f"[✓] JSON parsed corect: {result}")
        except json.JSONDecodeError as je:
            print(f"[✗] Eroare parse JSON: {je}")
            print(f"[*] Response text: {response_text}")
            # Fallback: returnez textul original
            return {"text": text, "source_lang": "en", "target_lang": "en"}
       
        # Validare că avem text și lang
         # Validare că avem text și lang
        if "text" not in result or "source_lang" not in result or "target_lang" not in result:
            print(f"[⚠] Response JSON invalid (missing keys): {result}")
            return {"text": text, "source_lang": "auto", "target_lang": "en"}

        if use_memory:
            # Salvăm în memorie ce s-a vorbit
            user_chat_histories[user].append({"role": "user", "content": text})
            user_chat_histories[user].append({"role": "assistant", "content": result['text']})

            # ⚡ LIMITARE STRICT: Păstrez doar ultimele 2 replici (4 mesaje)
            # Asta evită încetinirea exponențială când se acumulează prea mult istoric
            if len(user_chat_histories[user]) > 4:
                user_chat_histories[user] = user_chat_histories[user][-4:]
                print(f"[*] Istoric curățat: {len(user_chat_histories[user])} mesaje ramase")
       

        return result

    except Exception as e:

        print(f"[✗] Eroare AI Agent: {type(e).__name__}: {str(e)}")
        import traceback
        traceback.print_exc()

        return {"text": text, "lang": "en"}

@app.post("/ai_translate")
async def ai_translate(payload: dict, authorization: str = Header(default="")):
    """Endpoint pentru traducere inteligentă cu memorie folosind Groq"""
    print(f"\n[📥] /ai_translate apelat | Payload: {payload}")
    text = payload.get("text", "").strip()
    user = payload.get("user", "default")
    
    if not text:
        print("[⚠] Text gol")
        return {"status": "failed", "error": "text gol"}
    
    print(f"[*] Procesez cu AI: '{text}' pentru user: {user}")
    result = ai_agent_process(text, user)
    
    token = authorization.replace("Bearer ", "").strip()
    current_user = get_user_from_token(token)

    if current_user:
        history_item = {
            "source_lang": result.get("source_lang", "auto").lower(),
            "target_lang": result.get("target_lang", "en").lower(),
            "original_text": text,
            "translated_text": result.get("text", "")
        }
        save_history_entries(current_user["id"], [history_item])

    return result

@app.post("/auth/signup")
async def auth_signup(payload: dict):
    username = payload.get("username", "")
    email = payload.get("email", "")
    password = payload.get("password", "")
    main_language = payload.get("main_language", "")

    ok, err = create_user(username, email, password, main_language)
    if not ok:
        return {"status": "failed", "error": err}

    return {"status": "success"}

@app.post("/auth/login")
async def auth_login(payload: dict):
    email = payload.get("email", "")
    password = payload.get("password", "")
    user = verify_user(email, password)
    if not user:
        return {"status": "failed", "error": "Email sau parolă invalidă"}

    token = secrets.token_urlsafe(32)
    auth_sessions[token] = user
    return {"status": "success", "token": token, "user": user}

@app.get("/auth/me")
async def auth_me(authorization: str = Header(default="")):
    token = authorization.replace("Bearer ", "").strip()
    user = get_user_from_token(token)
    if not user:
        return {"status": "failed", "error": "Not authenticated"}
    return {"status": "success", "user": user}

@app.put("/auth/profile")
async def auth_profile(payload: dict, authorization: str = Header(default="")):
    token = authorization.replace("Bearer ", "").strip()
    user = get_user_from_token(token)
    if not user:
        return {"status": "failed", "error": "Not authenticated"}

    new_main_lang = update_user_main_language(user["id"], payload.get("main_language", ""))
    user["main_language"] = new_main_lang
    auth_sessions[token] = user
    return {"status": "success", "user": user}

@app.post("/history/bulk")
async def history_bulk_save(request: Request, authorization: str = Header(None)):
    token = (authorization or "").replace("Bearer ", "").strip()
    user = get_user_from_token(token)
    if not user:
        return {"status": "error", "message": "Neautorizat"}
    
    try:
        payload = await request.json()
        # Încercăm să luăm datele din 'entries' sau 'history'
        entries = payload.get("entries") or payload.get("history") or []
        
        print(f"[*] /history/bulk a primit {len(entries)} elemente de la frontend.")
        
        # APELĂM FUNCȚIA DE SALVARE
        save_history_entries(user["id"], entries)
        
        return {"status": "success"}
    except Exception as e:
        print(f"[✗] Eroare la procesarea cererii bulk: {e}")
        return {"status": "error", "message": str(e)}

@app.get("/history")
async def history_list(authorization: str = Header(default=""), order: str = Query(default="desc")):
    # 1. Extragere și verificare Token
    token = authorization.replace("Bearer ", "").strip()
    user = get_user_from_token(token)
    if not user:
        return {"status": "failed", "error": "Not authenticated"}

    try:
        # 2. Pregătire sortare (True pentru crescător, False pentru descrescător)
        is_ascending = (order.lower() == "desc")
        
        # 3. Cerem datele de la Supabase
        # .select("*") ia toate coloanele
        # .eq("user_id", ...) filtrează doar pentru user-ul logat
        # .order(...) sortează după id sau created_at
        response = supabase.table("translation_history") \
            .select("*") \
            .eq("user_id", user["id"]) \
            .order("id", desc=not is_ascending) \
            .execute()

        # 4. Trimitem datele înapoi la Frontend
        return {
            "status": "success",
            "entries": response.data, # .data conține lista de rânduri din tabel
        }
    except Exception as e:
        print(f"[✗] Eroare la citire istoric Supabase: {e}")
        return {"status": "error", "message": str(e)}

@app.post("/process")
async def process_audio(request: Request, audio: UploadFile = File(...), target_lang: str = 'en', authorization: str = Header(default="")):
    print(f"\n[📥] /process apelat | Target lang: {target_lang}")
    unique_id = str(uuid.uuid4())
    original_name = (audio.filename or "").lower()
    content_type = (audio.content_type or "").lower()
    input_ext = ".wav"
    if ".webm" in original_name or "webm" in content_type:
        input_ext = ".webm"
    elif ".mp4" in original_name or "mp4" in content_type:
        input_ext = ".mp4"
    elif ".ogg" in original_name or "ogg" in content_type:
        input_ext = ".ogg"
    input_audio = f"temp_{unique_id}{input_ext}"
    output_mp3 = f"tts_{unique_id}.mp3"
    
    print(f"[*] Salvez audio: {input_audio} (content-type: {content_type or 'unknown'})")
    payload = await audio.read()
    with open(input_audio, "wb") as f:
        f.write(payload)
    print(f"[✓] Audio salvat ({len(payload)} bytes)")

    try:
        # 1. Transcriere folosind Groq Cloud API
        print("[*] Incepe transcriere...")
        if len(payload) < 2048:
            print("[⚠] Fișier audio prea mic, ignorez")
            if os.path.exists(input_audio): os.remove(input_audio)
            return {"status": "ignored"}

        with open(input_audio, "rb") as file:
            transcription = client.audio.transcriptions.create(
                file=(input_audio, file.read()),
                model="whisper-large-v3"
            )
        
        original_text = transcription.text
        print(f"[✓] Transcriere reușită: '{original_text}'")
        
        if not original_text or len(original_text.strip()) < 2:
            print("[⚠] Text gol sau prea scurt, ignorez")
            if os.path.exists(input_audio): os.remove(input_audio)
            return {"status": "ignored"}

        # 2. Procesez cu AI care detectează limba țintă automat din cerere
        print(f"[*] Incepe procesare AI...")
        
        # Pentru /process evităm contextul anterior și lăsăm comanda vocală să decidă limba țintă.
        # Astfel "Translate into Chinese ..." nu mai este forțat accidental în EN.
        token = authorization.replace("Bearer ", "").strip()
        user = get_user_from_token(token)
        fallback_lang = (user or {}).get("main_language") or target_lang or "en"
        ai_result = ai_agent_process(
            original_text,
            user="audio_user",
            use_memory=False,
            default_target_lang=fallback_lang
        )
        print(f"[*] AI Result: {ai_result}")
        
        # Extragem totul din rezultatul AI
        translated_text = ai_result.get('text', original_text)
        # Prioritate: 1. Limba detectată de AI, 2. Limba detectată de Whisper, 3. 'auto'
        source_lang = ai_result.get('source_lang') or getattr(transcription, 'language', 'auto')
        # Prioritate: 1. Limba cerută de AI, 2. Limba cerută în URL (target_lang)
        final_target_lang = final_target_lang = ai_result.get('target_lang') or ai_result.get('lang') or target_lang

        # 3. GENERARE AUDIO UMAN (gTTS) - cu limba din AI result
        print(f"[*] Genereaza audio cu gTTS... limbă: {final_target_lang}")

        try:
            # Folosim limba finală decisă de AI
            tts = gTTS(text=translated_text, lang=final_target_lang)
            tts.save(output_mp3)
        
            import time
            attempts = 0
            while not os.path.exists(output_mp3) and attempts < 10:
                time.sleep(0.1)
                attempts += 1
            print(f"[✓] Audio salvat pe disc")

        except Exception as tts_err:
            print(f"[⚠] Eroare TTS pe limba {final_target_lang}, fallback pe en: {tts_err}")
            tts = gTTS(text=translated_text, lang='en')
            tts.save(output_mp3)


        if os.path.exists(input_audio): os.remove(input_audio)
        
        # Extragem limba detectată de Whisper (ex: 'ro', 'en', 'es')
        detected_lang = getattr(transcription, 'language', 'auto')

        # Returnăm datele cu limba în care s-a tradus (din AI result)
        # Detectăm dacă suntem pe Hugging Face pentru a forța HTTPS
        base_url = str(request.base_url).rstrip('/')
        if ".hf.space" in base_url:
            base_url = base_url.replace("http://", "https://")

        # Returnăm datele cu limba în care s-a tradus (din AI result)
        # --- PREGĂTIRE RĂSPUNS FINAL ---
        # Folosim base_url pregătit anterior pentru HTTPS/HuggingFace
        response_data = {
            "source_lang": source_lang,
            "target_lang": final_target_lang,
            "original_text": original_text,
            "translated_text": translated_text,
            "audio_url": f"{base_url}/get_audio/{output_mp3}",
            "status": "success"
        }

        print(f"[✓] Response gata: {response_data}")

        # --- SALVARE UNICĂ ÎN DB (Dacă userul e logat) ---
        if user:
            print(f"[*] Utilizator logat detectat ({user['username']}). Salvez în DB.")
            history_item = {
                "session_id": unique_id,
                "client_entry_id": str(uuid.uuid4()),
                "source_lang": str(source_lang or "auto").lower(),
                "target_lang": str(final_target_lang or "en").lower(),
                "original_text": original_text,
                "translated_text": translated_text
            }
            try:
                save_history_entries(user["id"], [history_item])
            except Exception as db_err:
                print(f"[⚠] Eroare salvare istoric: {db_err}")

        return response_data

    except Exception as e:
        print(f"[✗] EROARE procesare: {type(e).__name__} - {str(e)}")
        import traceback
        traceback.print_exc()
        if os.path.exists(input_audio): 
            os.remove(input_audio)
        return {"error": str(e), "status": "failed"}

@app.post("/translate_text")
async def translate_text(payload: dict):
    """Traduce text în timp real pentru live translation - folosind AI cu memorie"""
    print(f"\n[📥] /translate_text apelat | Payload: {payload}")
    text = payload.get("text", "").strip()
    target_lang = payload.get("target_lang", "en")
    user = payload.get("user", "live_user")
    
    if not text:
        print("[⚠] Text gol")
        return {"status": "failed", "error": "text gol"}
    
    print(f"[*] Traduc cu AI: '{text}' -> {target_lang} pentru {user}")
    
    # Folosesc AI translation cu memorie în loc de Google Translate direct
    ai_prompt = f"Tradu asta în {target_lang}: {text}"
    ai_result = ai_agent_process(ai_prompt, user=user, default_target_lang=target_lang)
    
    translated = ai_result.get('text', text)
    detected_lang = ai_result.get('lang', target_lang)
    
    print(f"[✓] Traducere reușită: {translated}")
    return {"status": "success", "translated_text": translated, "lang": detected_lang}

@app.get("/get_audio/{file_name}")
async def get_audio(file_name: str, background_tasks: BackgroundTasks):
    print(f"[📥] /get_audio apelat pentru: {file_name}")

    if os.path.exists(file_name):
        print(f"[✓] Fișier găsit, trimit și șterg după 15s...")
        async def remove_file_with_delay():
            await asyncio.sleep(15)  # Așteptăm 15 secunde înainte să ștergem
            try:
                if os.path.exists(file_name):
                    os.remove(file_name)
                    print(f"[*] Fișier curățat cu delay: {file_name}")
            except Exception as e:
                print(f"[✗] Eroare la ștergere: {e}")
        background_tasks.add_task(remove_file_with_delay)
        return FileResponse(file_name, media_type="audio/mpeg")
    else:
        print(f"[✗] Fișierul nu a fost găsit: {file_name}")
        # Attempt to clean up any orphaned files on miss
        cleanup_audio_files()
        return {"error": "Fișierul nu a fost găsit"}

if __name__ == "__main__":
    print("[*] Serverul pornește pe http://127.0.0.1:7860")
    uvicorn.run(app, host="127.0.0.1", port=7860)


    #microfon mut
    #ascendent descendent
    #traducerea live cu limba corecta