import os
import uuid
import uvicorn
from supabase import create_client, Client
from fastapi import FastAPI, UploadFile, File, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from gtts import gTTS
from fastapi.responses import FileResponse
from groq import Groq
from fastapi import BackgroundTasks, Header
import json
import asyncio
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
print("[✓] Conexiune Supabase inițializată")

# ─── Startup Cleanup ──────────────────────────────────────────────────────────
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"]
)

client = Groq(api_key=os.getenv("GROQ_API_KEY"))
print("[✓] Groq client inițializat cu succes")

user_chat_histories = {}

# ─── Auth helper ──────────────────────────────────────────────────────────────
def get_user_from_token(token: str):
    """Validate a Supabase JWT via the Auth API and return a normalized user dict."""
    if not token:
        return None
    try:
        response = supabase.auth.get_user(token)
        u = response.user
        if not u:
            return None
        meta = u.user_metadata or {}
        return {
            "id":            u.id,
            "email":         u.email or "",
            "username":      meta.get("username") or (u.email or "").split("@")[0],
            "main_language": meta.get("main_language"),
        }
    except Exception as e:
        print(f"[auth] Token invalid: {e}")
        return None

# ─── AI translation ───────────────────────────────────────────────────────────
def build_lang_instruction(native_lang: str, country_lang: str, default_target_lang: str) -> str:
    """
    Build the target-language decision rule injected into the AI system prompt.

    Rules (applied only when the user does NOT explicitly name a target language):

    CASE A — both native & country known, same language (e.g. nl=ro, cl=ro):
      • source == that language  →  translate to English
      • source != that language  →  translate to that language

    CASE B — both known, different (e.g. nl=ro, cl=de):
      • source == nl  →  translate to cl
      • source == cl  →  translate to nl
      • source is neither  →  translate to cl (user is in that country)

    CASE C — only native known:
      • source == nl  →  translate to English
      • source != nl  →  translate to nl

    CASE D — only country known:
      • source == cl  →  translate to English
      • source != cl  →  translate to cl

    CASE E — neither known:
      • source == English  →  translate to Spanish (globally understood)
      • source != English  →  translate to English
    """
    nl = (native_lang  or "").strip().lower()
    cl = (country_lang or "").strip().lower()

    if nl and cl:
        if nl == cl:
            return (
                f'REGULI LIMBĂ (nativă="{nl}", țară="{cl}", aceeași limbă):\n'
                f'- Dacă limba sursă DETECTATĂ este "{nl}", traduce în "en" (engleză).\n'
                f'- Dacă limba sursă DETECTATĂ NU este "{nl}", traduce în "{nl}".\n'
                f'- NICIODATĂ nu traduce în aceeași limbă ca sursa.'
            )
        else:
            return (
                f'REGULI LIMBĂ (nativă="{nl}", țară="{cl}", limbi diferite):\n'
                f'- Dacă limba sursă DETECTATĂ este "{nl}", traduce în "{cl}".\n'
                f'- Dacă limba sursă DETECTATĂ este "{cl}", traduce în "{nl}".\n'
                f'- Dacă sursa nu este nici "{nl}" nici "{cl}", traduce în "{cl}".\n'
                f'- NICIODATĂ nu traduce în aceeași limbă ca sursa.'
            )
    elif nl:
        return (
            f'REGULI LIMBĂ (nativă="{nl}", țară necunoscută):\n'
            f'- Dacă limba sursă DETECTATĂ este "{nl}", traduce în "en" (engleză).\n'
            f'- Dacă limba sursă DETECTATĂ NU este "{nl}", traduce în "{nl}".\n'
            f'- NICIODATĂ nu traduce în aceeași limbă ca sursa.'
        )
    elif cl:
        return (
            f'REGULI LIMBĂ (țară="{cl}", nativă necunoscută):\n'
            f'- Dacă limba sursă DETECTATĂ este "{cl}", traduce în "en" (engleză).\n'
            f'- Dacă limba sursă DETECTATĂ NU este "{cl}", traduce în "{cl}".\n'
            f'- NICIODATĂ nu traduce în aceeași limbă ca sursa.'
        )
    else:
        return (
            'REGULI LIMBĂ (nicio preferință setată):\n'
            '- Dacă limba sursă DETECTATĂ este "en" (engleză), traduce în "es" (spaniolă).\n'
            '- Dacă limba sursă DETECTATĂ NU este "en", traduce în "en" (engleză).\n'
            '- NICIODATĂ nu traduce în aceeași limbă ca sursa.'
        )


def ai_agent_process(text, user="default", use_memory=True, default_target_lang="en",
                     native_lang="", country_lang=""):
    global user_chat_histories
    if user not in user_chat_histories:
        user_chat_histories[user] = []

    lang_instruction = build_lang_instruction(native_lang, country_lang, default_target_lang)

    try:
        messages = [
            {
                "role": "system",
                "content": f"""Ești un motor de traducere PRECISE cu detecție automată a limbii țintă.

SARCINA TA EXACTĂ:
1. Analizează cererea utilizatorului.
2. Identifică LIMBA ȚINTĂ și TEXTUL de tradus.
3. DETERMINĂ CODUL ISO 639-1 CORECT al limbii țintă.
4. TRADUCE textul ÎN ACEA LIMBĂ.
5. Returnează NUMAI JSON: {{"text": "traducerea_exacta", "source_lang": "cod_sursa", "target_lang": "cod_tinta"}}

REGULI STRICTE:
- CODUL LIMBII TREBUIE SĂ FIE ISO 639-1 CORECT: "en", "ro", "es", "fr", "de", "it", "pt", "zh", "ja", "ko", "ru", "ar", etc.
- NU TRADUCE COMANDA, traduce DOAR TEXTUL.
- NU ADĂUGA explicații sau alt text.
- Răspunsul trebuie să fie STRICT JSON valid.
- NICIODATĂ nu returna aceeași limbă ca sursă și ca țintă. Dacă sursa și ținta ar fi identice, folosește "en" ca limbă țintă.
- {lang_instruction}
"""
            }
        ]

        if use_memory and user_chat_histories[user]:
            messages.extend(user_chat_histories[user][-2:])

        messages.append({"role": "user", "content": text})
        print(f"[*] Trimit la Groq: {len(messages)} mesaje, text: {text[:50]}...")

        chat_completion = client.chat.completions.create(
            messages=messages,
            model="llama-3.3-70b-versatile",
            response_format={"type": "json_object"},
            temperature=0.3,
        )

        response_text = chat_completion.choices[0].message.content
        print(f"[*] Raw Groq response: {response_text[:200]}")

        try:
            result = json.loads(response_text)
        except json.JSONDecodeError as je:
            print(f"[✗] Eroare parse JSON: {je}")
            return {"text": text, "source_lang": "en", "target_lang": "en"}

        if not all(k in result for k in ("text", "source_lang", "target_lang")):
            print(f"[⚠] Response JSON invalid: {result}")
            return {"text": text, "source_lang": "auto", "target_lang": "en"}

        if use_memory:
            user_chat_histories[user].append({"role": "user", "content": text})
            user_chat_histories[user].append({"role": "assistant", "content": result["text"]})
            if len(user_chat_histories[user]) > 4:
                user_chat_histories[user] = user_chat_histories[user][-4:]

        return result

    except Exception as e:
        print(f"[✗] Eroare AI Agent: {type(e).__name__}: {e}")
        import traceback; traceback.print_exc()
        return {"text": text, "source_lang": "auto", "target_lang": default_target_lang}

# ─── History helpers ──────────────────────────────────────────────────────────
def _authed_client(token: str):
    """Return a Supabase client authenticated as the user (so RLS sees auth.uid())."""
    c = create_client(SUPABASE_URL, SUPABASE_KEY)
    c.postgrest.auth(token)
    return c

def save_history_entries(user_id: str, entries: list, token: str = None):
    if not entries:
        return
    db = _authed_client(token) if token else supabase
    saved = skipped = failed = 0
    for entry in entries:
        row = {
            "user_id":         user_id,
            "session_id":      str(entry.get("session_id") or uuid.uuid4()),
            "client_entry_id": str(entry.get("client_entry_id") or uuid.uuid4()),
            "source_lang":     str(entry.get("source_lang") or "auto").lower(),
            "target_lang":     str(entry.get("target_lang") or "en").lower(),
            "original_text":   str(entry.get("original_text") or "").strip(),
            "translated_text": str(entry.get("translated_text") or "").strip(),
        }
        if entry.get("created_at"):
            row["created_at"] = entry["created_at"]
        try:
            result = db.table("translation_history_v2").insert(row).execute()
            if result.data:
                saved += 1
            else:
                print(f"[⚠] INSERT fără răspuns (RLS blocat?): {row}")
                failed += 1
        except Exception as e:
            err = str(e)
            if "23505" in err or "duplicate" in err.lower():
                skipped += 1
            else:
                print(f"[✗] Eroare salvare: {e}")
                failed += 1
    print(f"[Istoric] {saved} salvate, {skipped} duplicate, {failed} eșuate.")

# ─── History endpoints ────────────────────────────────────────────────────────
@app.post("/history/bulk")
async def history_bulk_save(request: Request, authorization: str = Header(None)):
    token = (authorization or "").replace("Bearer ", "").strip()
    user = get_user_from_token(token)
    if not user:
        return {"status": "error", "message": "Neautorizat"}
    try:
        payload = await request.json()
        entries = payload.get("entries") or payload.get("history") or []
        print(f"[bulk] User={user['username']} (id={user['id'][:8]}…), {len(entries)} intrări")
        save_history_entries(user["id"], entries, token=token)
        return {"status": "success"}
    except Exception as e:
        print(f"[bulk] ✗ Eroare: {e}")
        return {"status": "error", "message": str(e)}

@app.get("/history")
async def history_list(
    authorization: str = Header(default=""),
    order: str = Query(default="desc"),
):
    token = authorization.replace("Bearer ", "").strip()
    user = get_user_from_token(token)
    if not user:
        return {"status": "failed", "error": "Not authenticated"}
    try:
        is_asc = order.lower() == "asc"
        db = _authed_client(token)
        response = (
            db.table("translation_history_v2")
            .select("*")
            .eq("user_id", user["id"])
            .order("created_at", desc=not is_asc)
            .execute()
        )
        print(f"[history] User={user['username']} → {len(response.data)} intrări")
        return {"status": "success", "entries": response.data}
    except Exception as e:
        print(f"[history] ✗ Eroare: {e}")
        return {"status": "error", "message": str(e)}

# ─── TTS on-demand endpoint ──────────────────────────────────────────────────
@app.post("/tts")
async def generate_tts_endpoint(request: Request, payload: dict, background_tasks: BackgroundTasks):
    """Generate TTS audio for any text+lang — used by history playback."""
    text = (payload.get("text") or "").strip()
    lang = (payload.get("lang") or "en").strip().lower()[:2]
    if not text:
        return {"error": "text required"}

    unique_id  = str(uuid.uuid4())
    output_mp3 = f"tts_{unique_id}.mp3"
    try:
        try:
            gTTS(text=text, lang=lang).save(output_mp3)
        except Exception as tts_err:
            print(f"[⚠] TTS fallback en ({tts_err})")
            gTTS(text=text, lang="en").save(output_mp3)

        base_url = str(request.base_url).rstrip("/")
        if ".hf.space" in base_url:
            base_url = base_url.replace("http://", "https://")
        return {"audio_url": f"{base_url}/get_audio/{output_mp3}"}
    except Exception as e:
        print(f"[✗] /tts eroare: {e}")
        return {"error": str(e)}

# ─── Language normalizer endpoint ─────────────────────────────────────────────
@app.post("/normalize_language")
async def normalize_language(payload: dict):
    """Convert any language name/alias to ISO 639-1 code using Groq."""
    text = (payload.get("text") or "").strip()
    if not text:
        return {"iso_code": None}

    if len(text) == 2 and text.isalpha():
        return {"iso_code": text.lower()}

    try:
        chat = client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a language code normalizer. "
                        "Given any language name or alias in any language, "
                        'return ONLY valid JSON: {"iso_code": "xx"} where xx is the '
                        "ISO 639-1 two-letter code. If unknown, use null."
                    )
                },
                {"role": "user", "content": f'Language: "{text}"'}
            ],
            model="llama-3.3-70b-versatile",
            response_format={"type": "json_object"},
            temperature=0,
        )
        result = json.loads(chat.choices[0].message.content)
        code = (result.get("iso_code") or "").strip().lower()[:2] or None
        print(f"[✓] normalize_language '{text}' → '{code}'")
        return {"iso_code": code}
    except Exception as e:
        print(f"[✗] normalize_language eroare: {e}")
        return {"iso_code": text.lower()[:2] if len(text) >= 2 else None}

# ─── Country normalizer endpoint ──────────────────────────────────────────────
@app.post("/normalize_country")
async def normalize_country(payload: dict):
    """Convert any country name/alias to ISO 3166-1 alpha-2 code using Groq."""
    text = (payload.get("text") or "").strip()
    if not text:
        return {"iso_code": None, "name": None}

    if len(text) == 2 and text.isalpha():
        return {"iso_code": text.upper(), "name": None}

    try:
        chat = client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a country code normalizer. "
                        "Given any country name or alias in any language, "
                        'return ONLY valid JSON: {"iso_code": "XX", "name": "Full Country Name in English"} '
                        "where XX is the ISO 3166-1 alpha-2 two-letter code in UPPERCASE. "
                        "If unknown, return null for both fields."
                    )
                },
                {"role": "user", "content": f'Country: "{text}"'}
            ],
            model="llama-3.3-70b-versatile",
            response_format={"type": "json_object"},
            temperature=0,
        )
        result = json.loads(chat.choices[0].message.content)
        code = (result.get("iso_code") or "").strip().upper()[:2] or None
        name = (result.get("name") or "").strip() or None
        print(f"[✓] normalize_country '{text}' → '{code}' ({name})")
        return {"iso_code": code, "name": name}
    except Exception as e:
        print(f"[✗] normalize_country eroare: {e}")
        return {"iso_code": text.upper()[:2] if len(text) >= 2 else None, "name": None}

# ─── AI translate endpoint ────────────────────────────────────────────────────
@app.post("/ai_translate")
async def ai_translate(payload: dict, authorization: str = Header(default="")):
    text = payload.get("text", "").strip()
    user_key = payload.get("user", "default")
    if not text:
        return {"status": "failed", "error": "text gol"}

    result = ai_agent_process(text, user_key)

    token = authorization.replace("Bearer ", "").strip()
    current_user = get_user_from_token(token)
    if current_user:
        save_history_entries(current_user["id"], [{
            "source_lang":     result.get("source_lang", "auto"),
            "target_lang":     result.get("target_lang", "en"),
            "original_text":   text,
            "translated_text": result.get("text", ""),
        }], token=token)

    return result

@app.patch("/history/{client_entry_id}")
async def update_history_entry(client_entry_id: str, payload: dict, authorization: str = Header(None)):
    """Update an existing history entry after the user edits the original text."""
    token = (authorization or "").replace("Bearer ", "").strip()
    if not token:
        return {"status": "error", "message": "Unauthorized"}
    user = get_user_from_token(token)
    if not user:
        return {"status": "error", "message": "Invalid token"}
    updates = {}
    for field in ("original_text", "translated_text", "source_lang", "target_lang"):
        if field in payload:
            val = payload[field]
            updates[field] = val.lower() if field in ("source_lang", "target_lang") else val
    updates["edited"] = True  # always mark as edited when this endpoint is called
    if not updates:
        return {"status": "error", "message": "No fields to update"}
    try:
        db = _authed_client(token)
        db.table("translation_history_v2") \
            .update(updates) \
            .eq("client_entry_id", client_entry_id) \
            .eq("user_id", user["id"]) \
            .execute()
        print(f"[DB] ✓ Entry {client_entry_id[:8]}… updated")
        return {"status": "success"}
    except Exception as e:
        print(f"[DB] ✗ Update failed: {e}")
        return {"status": "error", "message": str(e)}


@app.post("/translate_text")
async def translate_text(payload: dict):
    text         = payload.get("text", "").strip()
    target_lang  = payload.get("target_lang", "en")
    native_lang  = payload.get("native_lang", "")
    country_lang = payload.get("country_lang", "")
    user_key     = payload.get("user", "live_user")
    no_memory    = payload.get("no_memory", False)
    if not text:
        return {"status": "failed", "error": "text gol"}
    result = ai_agent_process(text, user=user_key, use_memory=not no_memory,
                              default_target_lang=target_lang,
                              native_lang=native_lang, country_lang=country_lang)
    return {
        "status":         "success",
        "translated_text": result.get("text", text),
        "source_lang":     result.get("source_lang", "auto"),
        "lang":            result.get("target_lang", target_lang),
    }

# ─── Audio processing endpoint ────────────────────────────────────────────────
@app.post("/process")
async def process_audio(
    request: Request,
    audio: UploadFile = File(...),
    target_lang: str = "en",
    client_entry_id: str = "",
    native_lang: str = "",
    country_lang: str = "",
    authorization: str = Header(default=""),
):
    print(f"\n[📥] /process apelat | Target lang: {target_lang}")
    unique_id     = str(uuid.uuid4())
    original_name = (audio.filename or "").lower()
    content_type  = (audio.content_type or "").lower()

    input_ext = ".wav"
    if ".webm" in original_name or "webm" in content_type: input_ext = ".webm"
    elif ".mp4" in original_name or "mp4" in content_type: input_ext = ".mp4"
    elif ".ogg" in original_name or "ogg" in content_type: input_ext = ".ogg"

    input_audio = f"temp_{unique_id}{input_ext}"
    output_mp3  = f"tts_{unique_id}.mp3"

    payload_bytes = await audio.read()
    with open(input_audio, "wb") as f:
        f.write(payload_bytes)
    print(f"[✓] Audio salvat ({len(payload_bytes)} bytes)")

    try:
        if len(payload_bytes) < 2048:
            if os.path.exists(input_audio): os.remove(input_audio)
            return {"status": "ignored"}

        with open(input_audio, "rb") as f:
            transcription = client.audio.transcriptions.create(
                file=(input_audio, f.read()),
                model="whisper-large-v3",
            )

        original_text = transcription.text
        print(f"[✓] Transcriere: '{original_text}'")

        if not original_text or len(original_text.strip()) < 2:
            if os.path.exists(input_audio): os.remove(input_audio)
            return {"status": "ignored"}

        token        = authorization.replace("Bearer ", "").strip()
        current_user = get_user_from_token(token)
        fallback_lang = (current_user or {}).get("main_language") or target_lang or "en"

        ai_result = ai_agent_process(
            original_text, user="audio_user",
            use_memory=False, default_target_lang=fallback_lang,
            native_lang=native_lang, country_lang=country_lang,
        )
        print(f"[*] AI Result: {ai_result}")

        translated_text   = ai_result.get("text", original_text)
        # Whisper's language detection is more reliable than AI's source_lang guess
        whisper_lang      = getattr(transcription, "language", None)
        source_lang       = whisper_lang or ai_result.get("source_lang") or "auto"
        final_target_lang = ai_result.get("target_lang") or ai_result.get("lang") or target_lang

        try:
            gTTS(text=translated_text, lang=final_target_lang).save(output_mp3)
        except Exception as tts_err:
            print(f"[⚠] TTS fallback en: {tts_err}")
            gTTS(text=translated_text, lang="en").save(output_mp3)

        if os.path.exists(input_audio): os.remove(input_audio)

        base_url = str(request.base_url).rstrip("/")
        if ".hf.space" in base_url:
            base_url = base_url.replace("http://", "https://")

        return {
            "status":          "success",
            "source_lang":     source_lang,
            "target_lang":     final_target_lang,
            "original_text":   original_text,
            "translated_text": translated_text,
            "audio_url":       f"{base_url}/get_audio/{output_mp3}",
        }

    except Exception as e:
        print(f"[✗] EROARE procesare: {type(e).__name__} - {e}")
        import traceback; traceback.print_exc()
        if os.path.exists(input_audio): os.remove(input_audio)
        return {"error": str(e), "status": "failed"}

# ─── Audio delivery ───────────────────────────────────────────────────────────
@app.get("/get_audio/{file_name}")
async def get_audio(file_name: str, background_tasks: BackgroundTasks):
    if os.path.exists(file_name):
        async def _remove():
            await asyncio.sleep(15)
            try:
                if os.path.exists(file_name): os.remove(file_name)
            except Exception as e:
                print(f"[✗] Eroare ștergere: {e}")
        background_tasks.add_task(_remove)
        return FileResponse(file_name, media_type="audio/mpeg")
    cleanup_audio_files()
    return {"error": "Fișierul nu a fost găsit"}

if __name__ == "__main__":
    print("[*] Serverul pornește pe http://127.0.0.1:7860")
    uvicorn.run(app, host="127.0.0.1", port=7860)
