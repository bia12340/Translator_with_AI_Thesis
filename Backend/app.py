import os
import uuid
import base64
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
import time
from dotenv import load_dotenv
from fast_langdetect import detect as fastlang_detect
import langcodes

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

print("[✓] fast-langdetect disponibil")

_timings: dict = {}          # colectare timpi pipeline per cerere

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

# ─── Whisper language name → ISO 639-1 ───────────────────────────────────────
def normalize_whisper_lang(lang: str):
    """Convertește numele limbii returnat de Whisper la cod ISO 639-1."""
    if not lang:
        return None
    l = lang.strip()
    if len(l) == 2 and l.isalpha():
        return l.lower()
    try:
        return langcodes.find(l).language
    except Exception:
        return None

# ─── Session-aware target language ────────────────────────────────────────────
session_lang_pairs = {}   # session_id → {"detected": str, "target": str}

def determine_target_lang(detected_lang: str, native_lang: str, country_lang: str) -> str:
    """
    Mecanismul de direcționare bazat pe profilul utilizatorului (cele 5 cazuri).
    Oglindește exact diagrama de decizie din lucrare.
    Returnează codul ISO 639-1 al limbii țintă.
    """
    dl = (detected_lang or "").strip().lower()
    nl = (native_lang   or "").strip().lower()
    cl = (country_lang  or "").strip().lower()

    if nl:
        if cl:
            if nl == cl:
                # Caz A: ambele configurate, aceeași limbă
                if dl == nl:
                    return "en"
                else:
                    return nl
            else:
                # Caz B: ambele configurate, limbi diferite
                if dl == nl:
                    return cl
                else:
                    return nl
        else:
            # Caz C: doar limba nativă configurată
            if dl == nl:
                return "en"
            else:
                return nl
    else:
        if cl:
            # Caz D: doar țara configurată
            if dl == cl:
                return "en"
            else:
                return cl
        else:
            # Caz E: nicio preferință
            if dl == "en":
                return "es"
            else:
                return "en"


def detect_text_lang(text: str) -> str:
    """Detectează limba unui text folosind fast-langdetect. Returnează codul ISO 639-1."""
    if not text or len(text.strip()) < 2:
        return "auto"
    try:
        result = fastlang_detect(text.strip())
        if result:
            return result[0]["lang"].lower()
        return "auto"
    except Exception:
        return "auto"


def compute_target_lang(detected_lang: str, session_id: str,
                        native_lang: str, country_lang: str) -> str:
    """
    Determină limba țintă ținând cont de conversația anterioară din sesiune.
    - Prima traducere din sesiune  → mecanismul de direcționare (profil).
    - Continuare conversație        → folosește perechea salvată anterior.
    """
    dl = (detected_lang or "").strip().lower()
    pair = session_lang_pairs.get(session_id) if session_id else None

    if not pair:
        # Prima traducere din sesiune
        return determine_target_lang(dl, native_lang, country_lang)

    prev_detected = pair.get("detected", "")
    prev_target   = pair.get("target", "")

    if dl == prev_target:
        # Vorbește acum în limba în care s-a tradus anterior → întoarce conversația
        return prev_detected
    elif dl == prev_detected:
        # Continuă în aceeași limbă → aceeași direcție ca înainte
        return prev_target
    else:
        # Limbă nouă, neașteptată → recalculează din profil
        return determine_target_lang(dl, native_lang, country_lang)


def ai_agent_process(text, target_lang="en"):
    system_content = f"""Ești un motor de traducere PRECIS. Urmează instrucțiunile STRICT.

SARCINA TA EXACTĂ:
1. Analizează cererea utilizatorului.
2. Dacă textul conține o COMANDĂ explicită de traducere (ex: "translate to Spanish I want apples"):
    - Identifică LIMBA ȚINTĂ și TEXTUL de tradus (ex: "Spanish", "I want apples")
    - DETERMINĂ CODUL ISO 639-1 CORECT al limbii țintă (ex: "es")
    - SALVEAZĂ 1 în "command"
    - TRADU textul ÎN LIMBA identificată!!! (ex: "Quiero manzanas")
3. Dacă textul NU conține o COMANDĂ explicită de traducere:
    - SALVEAZĂ 0 în "command"
    - Tradu OBLIGATORIU în limba cu codul ISO 639-1 acesta: "{target_lang}"
4. Returnează NUMAI JSON: {{"text": "traducerea_exacta", "source_lang": "cod_sursa", "target_lang": "cod_tinta", "command":"command_bool"}}

REGULI STRICTE:
- CODUL LIMBII TREBUIE SĂ FIE ISO 639-1 CORECT: "en", "ro", "es", "fr", "de", "it", "pt", "zh", "ja", "ko", "ru", "ar", etc.
- NU TRADUCE COMANDA, traduce DOAR TEXTUL.
- NU ADĂUGA explicații sau alt text.
- Chiar daca mesajul este o intrebare NU ESTE PENTRU TINE. Doar tradu intrebarea asa cum e
- Răspunsul trebuie să fie STRICT JSON valid.
"""

    try:
        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": text},
        ]
        print(f"[*] Trimit la Groq: {len(messages)} mesaje, text: {text[:50]}...")

        _t0 = time.perf_counter()
        chat_completion = client.chat.completions.create(
            messages=messages,
            model="llama-3.3-70b-versatile",
            response_format={"type": "json_object"},
            temperature=0.3,
        )
        _t1 = time.perf_counter()
        _timings['llm_ms'] = (_t1 - _t0) * 1000   # stocat, printat la final

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

        return result

    except Exception as e:
        print(f"[✗] Eroare AI Agent: {type(e).__name__}: {e}")
        import traceback; traceback.print_exc()
        return {"text": text, "source_lang": "auto", "target_lang": target_lang}

def retranslate(text: str, target_lang: str) -> dict:
    """Re-traducere cu prompt minimal când LLM nu a respectat limba țintă."""
    try:
        chat = client.chat.completions.create(
            messages=[
                {"role": "system", "content":
                    f'Translate the text to {target_lang}. '
                    f'Return ONLY JSON: {{"text": "...", "source_lang": "...", "target_lang": "..."}}'},
                {"role": "user", "content": text}
            ],
            model="llama-3.3-70b-versatile",
            response_format={"type": "json_object"},
            temperature=0.3,
        )
        return json.loads(chat.choices[0].message.content)
    except Exception as e:
        print(f"[✗] retranslate eroare: {e}")
        return {"text": text, "source_lang": "auto", "target_lang": target_lang}

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
        entries = response.data or []

        # Adaugă session_name din tabela sessions
        sessions_resp = (
            db.table("sessions")
            .select("session_id, name")
            .eq("user_id", user["id"])
            .execute()
        )
        session_names = {
            s["session_id"]: s.get("name")
            for s in (sessions_resp.data or [])
        }
        for entry in entries:
            entry["session_name"] = session_names.get(entry.get("session_id"))

        print(f"[history] User={user['username']} → {len(entries)} intrări")
        return {"status": "success", "entries": entries}
    except Exception as e:
        print(f"[history] ✗ Eroare: {e}")
        return {"status": "error", "message": str(e)}

# ─── TTS on-demand endpoint ──────────────────────────────────────────────────
@app.post("/tts")
async def generate_tts_endpoint(request: Request, payload: dict):
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

@app.post("/retranslate")
async def retranslate_endpoint(payload: dict):
    """Re-traducere după editarea unui card — target cunoscut, prompt minimal."""
    text        = (payload.get("text") or "").strip()
    target_lang = (payload.get("target_lang") or "en").strip().lower()
    if not text:
        return {"status": "failed", "error": "text gol"}
    result = retranslate(text, target_lang)
    return {
        "status":          "success",
        "translated_text": result.get("text", text),
        "source_lang":     result.get("source_lang", "auto"),
        "lang":            result.get("target_lang", target_lang),
    }


@app.delete("/history/{client_entry_id}")
async def delete_history_entry(client_entry_id: str, authorization: str = Header(None)):
    """Delete a single history entry by client_entry_id."""
    token = (authorization or "").replace("Bearer ", "").strip()
    if not token:
        return {"status": "error", "message": "Unauthorized"}
    user = get_user_from_token(token)
    if not user:
        return {"status": "error", "message": "Invalid token"}
    try:
        db = _authed_client(token)
        db.table("translation_history_v2") \
            .delete() \
            .eq("client_entry_id", client_entry_id) \
            .eq("user_id", user["id"]) \
            .execute()
        print(f"[DB] ✓ Entry {client_entry_id[:8]}… deleted")
        return {"status": "success"}
    except Exception as e:
        print(f"[DB] ✗ Delete failed: {e}")
        return {"status": "error", "message": str(e)}

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


@app.post("/sessions")
async def create_session(payload: dict, authorization: str = Header(None)):
    """Create a new session entry in the sessions table."""
    token = (authorization or "").replace("Bearer ", "").strip()
    if not token:
        return {"status": "error", "message": "Unauthorized"}
    user = get_user_from_token(token)
    if not user:
        return {"status": "error", "message": "Invalid token"}
    session_id = (payload.get("session_id") or "").strip()
    if not session_id:
        return {"status": "error", "message": "session_id required"}
    try:
        db = _authed_client(token)
        db.table("sessions").upsert({
            "session_id": session_id,
            "user_id":    user["id"],
            "name":       None,
        }).execute()
        print(f"[DB] ✓ Session {session_id[:8]}… created")
        return {"status": "success"}
    except Exception as e:
        print(f"[DB] ✗ Session create failed: {e}")
        return {"status": "error", "message": str(e)}

@app.patch("/session/{session_id}")
async def rename_session(session_id: str, payload: dict, authorization: str = Header(None)):
    """Rename a session by updating session_name for all its entries."""
    token = (authorization or "").replace("Bearer ", "").strip()
    if not token:
        return {"status": "error", "message": "Unauthorized"}
    user = get_user_from_token(token)
    if not user:
        return {"status": "error", "message": "Invalid token"}
    name = (payload.get("name") or "").strip()
    try:
        db = _authed_client(token)
        db.table("sessions").upsert({
            "session_id": session_id,
            "user_id":    user["id"],
            "name":       name if name else None,
        }).execute()
        print(f"[DB] ✓ Session {session_id[:8]}… renamed to '{name}'")
        return {"status": "success"}
    except Exception as e:
        print(f"[DB] ✗ Rename session failed: {e}")
        return {"status": "error", "message": str(e)}

@app.post("/translate_text")
async def translate_text(payload: dict):
    text         = payload.get("text", "").strip()
    native_lang  = payload.get("native_lang", "")
    country_lang = payload.get("country_lang", "")
    with_tts     = payload.get("with_tts", False)
    if not text:
        return {"status": "failed", "error": "text gol"}

    _t_total0 = time.perf_counter()

    _t_det0  = time.perf_counter()
    detected = detect_text_lang(text)
    _t_det1  = time.perf_counter()
    target_lang = determine_target_lang(detected, native_lang, country_lang)
    print(f"[text] fast-langdetect: '{detected}' → target: '{target_lang}'")

    result = ai_agent_process(text, target_lang=target_lang)

    llm_ms_first = _timings.get('llm_ms', 0)
    llm_ms_retry = 0
    retranslated = False
    llm_source   = (result.get("source_lang") or "").strip().lower()
    llm_target   = (result.get("target_lang") or "").strip().lower()

    if llm_source and llm_source != detected:
        corrected_target = determine_target_lang(llm_source, native_lang, country_lang)
        if corrected_target != llm_target:
            print(f"[text] Re-traducere: fast='{detected}' llm_src='{llm_source}' "
                  f"old_target='{llm_target}' new_target='{corrected_target}'")
            result        = ai_agent_process(text, target_lang=corrected_target)
            llm_ms_retry  = _timings.get('llm_ms', 0)
            target_lang   = corrected_target
            retranslated  = True

    llm_ms_total    = llm_ms_first
    translated_text = result.get("text", text)
    final_lang      = result.get("target_lang", target_lang)

    audio_b64 = None
    tts_ms = 0
    if with_tts and translated_text:
        _t_tts0 = time.perf_counter()
        unique_id  = str(uuid.uuid4())
        output_mp3 = f"tts_{unique_id}.mp3"
        try:
            gTTS(text=translated_text, lang=final_lang).save(output_mp3)
        except Exception:
            gTTS(text=translated_text, lang="en").save(output_mp3)
        with open(output_mp3, "rb") as f:
            audio_b64 = base64.b64encode(f.read()).decode()
        if os.path.exists(output_mp3): os.remove(output_mp3)
        tts_ms = (time.perf_counter() - _t_tts0) * 1000

    retry_line = f"  {'Llama retry':22} {llm_ms_retry:>7.0f} ms\n" if retranslated else ""
    tts_line   = f"  {'gTTS  (TTS)':22} {tts_ms:>7.0f} ms\n" if with_tts else ""
    print(
        f"\n{'─' * 48}\n"
        f"  {'fast-langdetect':22} {(_t_det1 - _t_det0) * 1000:>7.0f} ms\n"
        f"  {'Llama 3.3-70B (LLM)':22} {llm_ms_total:>7.0f} ms\n"
        + retry_line + tts_line +
        f"  {'─' * 32}\n"
        f"  {'TOTAL':22} {(time.perf_counter() - _t_total0) * 1000:>7.0f} ms\n"
        f"{'─' * 48}\n"
    )

    return {
        "status":          "success",
        "translated_text": translated_text,
        "source_lang":     result.get("source_lang", detected),
        "lang":            final_lang,
        "audio_data":      audio_b64,
    }

# ─── Audio processing endpoint ────────────────────────────────────────────────
@app.post("/process")
async def process_audio(
    request: Request,
    audio: UploadFile = File(...),
    target_lang: str = "en",
    client_entry_id: str = "",
    session_id: str = "",
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

        _t_asr0 = time.perf_counter()
        with open(input_audio, "rb") as f:
            transcription = client.audio.transcriptions.create(
                file=(input_audio, f.read()),
                model="whisper-large-v3",
                response_format="verbose_json",
            )
        _t_asr1 = time.perf_counter()
        _timings.clear()
        _timings['asr_ms'] = (_t_asr1 - _t_asr0) * 1000

        original_text = transcription.text
        print(f"[✓] Transcriere: '{original_text}'")

        if not original_text or len(original_text.strip()) < 2:
            if os.path.exists(input_audio): os.remove(input_audio)
            return {"status": "ignored"}

        # Whisper's language detection is more reliable than AI's source_lang guess
        whisper_lang = normalize_whisper_lang(getattr(transcription, "language", None))
        detected     = whisper_lang or "auto"
        print(f"[LANG] whisper='{whisper_lang}' detected='{detected}'")

        # Determină limba țintă (cu mecanismul de continuare a conversației pe sesiune)
        tgt = compute_target_lang(detected, session_id, native_lang, country_lang)

        ai_result = ai_agent_process(original_text, target_lang=tgt)
        print(f"[*] AI Result: {ai_result}")

        llm_target = (ai_result.get("target_lang") or "").strip().lower()
        command    = int(ai_result.get("command", 0))

        # Dacă nu e comandă explicită și LLM a tradus în altă limbă decât tgt → re-traducere
        if command == 0 and llm_target != tgt:
            print(f"[⚠] command=0, llm_target='{llm_target}' != tgt='{tgt}' → re-traducere")
            _t_retry0 = time.perf_counter()
            ai_result = retranslate(original_text, tgt)
            _t_retry1 = time.perf_counter()
            _timings['retry_ms'] = (_t_retry1 - _t_retry0) * 1000
            llm_target = (ai_result.get("target_lang") or tgt).strip().lower()

        translated_text = ai_result.get("text", original_text)
        source_lang     = whisper_lang or ai_result.get("source_lang") or "auto"
        final_target_lang = llm_target if (len(llm_target) == 2 and llm_target.isalpha()) else tgt

        print(f"[DIR] whisper='{whisper_lang}' detected='{detected}' tgt='{tgt}' llm_target='{llm_target}' final='{final_target_lang}'")

        # Salvează perechea de limbi pentru continuarea conversației din sesiune
        # Folosim 'detected' (de la Whisper, cod ISO fiabil) și 'final_target_lang' (normalizat)
        if session_id and detected != "auto":
            session_lang_pairs[session_id] = {
                "detected": detected,
                "target":   final_target_lang,
            }
            print(f"[SESSION] {session_id[:8]}… salvat: {detected} → {final_target_lang}")
            # Cleanup: păstrăm maxim 500 sesiuni în memorie
            if len(session_lang_pairs) > 500:
                oldest = list(session_lang_pairs.keys())[0]
                del session_lang_pairs[oldest]

        _t_tts0 = time.perf_counter()
        try:
            gTTS(text=translated_text, lang=final_target_lang).save(output_mp3)
        except Exception as tts_err:
            print(f"[⚠] TTS fallback en: {tts_err}")
            gTTS(text=translated_text, lang="en").save(output_mp3)
        _t_tts1 = time.perf_counter()
        _timings['tts_ms'] = (_t_tts1 - _t_tts0) * 1000
        _timings['total_ms'] = (_t_tts1 - _t_asr0) * 1000

        retry_line = (
            f"  {'Llama retry':22} {_timings.get('retry_ms', 0):>7.0f} ms\n"
            if 'retry_ms' in _timings else ""
        )
        print(
            f"\n{'─' * 48}\n"
            f"  {'Whisper  (ASR)':22} {_timings.get('asr_ms', 0):>7.0f} ms\n"
            f"  {'Llama 3.3-70B (LLM)':22} {_timings.get('llm_ms', 0):>7.0f} ms\n"
            + retry_line +
            f"  {'gTTS  (TTS)':22} {_timings.get('tts_ms', 0):>7.0f} ms\n"
            f"  {'─' * 32}\n"
            f"  {'TOTAL':22} {_timings.get('total_ms', 0):>7.0f} ms\n"
            f"{'─' * 48}\n"
        )

        if os.path.exists(input_audio): os.remove(input_audio)

        # Citește MP3-ul și îl trimite direct ca base64 — elimină round-trip-ul suplimentar
        with open(output_mp3, "rb") as f:
            audio_b64 = base64.b64encode(f.read()).decode()
        if os.path.exists(output_mp3): os.remove(output_mp3)

        return {
            "status":          "success",
            "source_lang":     source_lang,
            "target_lang":     final_target_lang,
            "original_text":   original_text,
            "translated_text": translated_text,
            "audio_data":      audio_b64,
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
