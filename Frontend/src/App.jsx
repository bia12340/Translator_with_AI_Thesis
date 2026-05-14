import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from './supabaseClient'
import {
  Sun, Moon, User, Copy, Volume2, VolumeX, Mic,
  LogOut, Settings, ChevronRight, ChevronDown, Pencil,
  Clock, Globe, MapPin, Languages, History, LogIn,
  UserPlus, Camera, Eye, EyeOff, FileText, Keyboard,
} from 'lucide-react'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:7860';

// ─── Theme ────────────────────────────────────────────────────────────────────
function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark')
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])
  return [theme, () => setTheme(t => t === 'dark' ? 'light' : 'dark')]
}

// ─── Mute — ref keeps closure always fresh ─────────────────────────────────
function useMute() {
  const [muted, _setMuted] = useState(() => localStorage.getItem('tts_muted') === 'true')
  const mutedRef = useRef(muted)
  const setMuted = useCallback((val) => {
    const next = typeof val === 'function' ? val(mutedRef.current) : val
    mutedRef.current = next
    localStorage.setItem('tts_muted', String(next))
    _setMuted(next)
  }, [])
  const toggle = useCallback(() => setMuted(m => !m), [setMuted])
  return [muted, mutedRef, toggle, setMuted]
}

// ─── Icons ────────────────────────────────────────────────────────────────────
const IconSun      = () => <Sun size={18} />
const IconMoon     = () => <Moon size={18} />
const IconUser     = ({ size=20 }) => <User size={size} />
const IconCopy     = () => <Copy size={15} />
const IconVolume   = ({ size=15 }) => <Volume2 size={size} />
const IconMute     = ({ size=15 }) => <VolumeX size={size} />
const IconMic      = () => <Mic size={20} />
const IconLogout   = () => <LogOut size={16} />
const IconSettings = () => <Settings size={16} />
const IconProfile  = () => <User size={16} />
const IconChevR    = () => <ChevronRight size={16} />
const IconChevD    = () => <ChevronDown size={16} />
const IconEdit     = ({ size=14 }) => <Pencil size={size} />
const IconClock    = () => <Clock size={12} />
const IconGlobe    = () => <Globe size={16} />
const IconMapPin   = () => <MapPin size={16} />
const IconTranslate= () => <Languages size={22} />
const IconHistory  = () => <History size={16} />
const IconSignIn   = () => <LogIn size={16} />
const IconUserPlus = () => <UserPlus size={16} />
const IconCamera   = () => <Camera size={16} />

// ─── Lang names ───────────────────────────────────────────────────────────────
const LANG_NAMES = { ro:'Romanian',en:'English',fr:'French',de:'German',es:'Spanish',it:'Italian',pt:'Portuguese',zh:'Chinese',ja:'Japanese',ko:'Korean',ru:'Russian',ar:'Arabic',pl:'Polish',nl:'Dutch',tr:'Turkish',hi:'Hindi',vi:'Vietnamese',th:'Thai',auto:'Auto-detect' }
const getLangName = c => LANG_NAMES[(c||'').toLowerCase()] || (c||'').toUpperCase()

// ─── Country → primary language ───────────────────────────────────────────────
const COUNTRY_TO_LANG = {
  AD:'ca', AE:'ar', AL:'sq', AM:'hy', AR:'es', AT:'de', AU:'en', AZ:'az',
  BA:'bs', BE:'nl', BG:'bg', BR:'pt', BY:'be', CA:'en', CH:'de', CN:'zh',
  CY:'el', CZ:'cs', DE:'de', DK:'da', EE:'et', EG:'ar', ES:'es', FI:'fi',
  FR:'fr', GB:'en', GE:'ka', GR:'el', HR:'hr', HU:'hu', ID:'id', IE:'en',
  IL:'he', IN:'hi', IS:'is', IT:'it', JP:'ja', KR:'ko', KZ:'kk', LT:'lt',
  LU:'fr', LV:'lv', MA:'ar', MD:'ro', ME:'sr', MK:'mk', MT:'mt', MX:'es',
  NL:'nl', NO:'no', NZ:'en', PL:'pl', PT:'pt', RO:'ro', RS:'sr', RU:'ru',
  SE:'sv', SI:'sl', SK:'sk', TH:'th', TR:'tr', UA:'uk', US:'en', UZ:'uz',
  VN:'vi', XK:'sq', ZA:'en',
}
const countryToLang = code => COUNTRY_TO_LANG[(code || '').toUpperCase()] || ''

// ─── Country names ────────────────────────────────────────────────────────────
const COUNTRY_NAMES = {
  AD:'Andorra',AE:'United Arab Emirates',AL:'Albania',AM:'Armenia',AT:'Austria',
  AU:'Australia',AZ:'Azerbaijan',BA:'Bosnia and Herzegovina',BE:'Belgium',BG:'Bulgaria',
  BR:'Brazil',BY:'Belarus',CA:'Canada',CH:'Switzerland',CN:'China',CY:'Cyprus',
  CZ:'Czech Republic',DE:'Germany',DK:'Denmark',EE:'Estonia',EG:'Egypt',
  ES:'Spain',FI:'Finland',FR:'France',GB:'United Kingdom',GE:'Georgia',
  GR:'Greece',HR:'Croatia',HU:'Hungary',ID:'Indonesia',IE:'Ireland',
  IL:'Israel',IN:'India',IS:'Iceland',IT:'Italy',JP:'Japan',
  KR:'South Korea',KZ:'Kazakhstan',LT:'Lithuania',LU:'Luxembourg',LV:'Latvia',
  MA:'Morocco',MD:'Moldova',ME:'Montenegro',MK:'North Macedonia',MT:'Malta',
  MX:'Mexico',NL:'Netherlands',NO:'Norway',NZ:'New Zealand',PL:'Poland',
  PT:'Portugal',RO:'Romania',RS:'Serbia',RU:'Russia',SE:'Sweden',
  SI:'Slovenia',SK:'Slovakia',TH:'Thailand',TR:'Turkey',UA:'Ukraine',
  US:'United States',UZ:'Uzbekistan',VN:'Vietnam',XK:'Kosovo',ZA:'South Africa',
}
const getCountryDisplay = code => {
  if (!code) return ''
  const up = code.toUpperCase()
  return COUNTRY_NAMES[up] ? `${COUNTRY_NAMES[up]} (${up})` : up
}

// ─── Audio helpers ─────────────────────────────────────────────────────────────
const speakText = (text, lang) => {
  if (!text || !('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  utt.lang = (lang || 'en').toLowerCase().slice(0, 2)
  window.speechSynthesis.speak(utt)
}

const playAudioUrl = (url) => new Promise(resolve => {
  if (!url) { resolve(); return }
  const a = new Audio(url)
  a.onended = resolve
  a.onerror  = resolve
  a.play().catch(resolve)
})

// ─── TranslationCard ──────────────────────────────────────────────────────────
function TranslationCard({ entry, muted, onRetranslate, onSaveEdit }) {
  const [copied,    setCopied]    = useState(false)
  const [playing,   setPlaying]   = useState(false)
  const [editing,   setEditing]   = useState(false)
  const [editValue, setEditValue] = useState((entry.original_text || '').trim())
  const [isEdited,  setIsEdited]  = useState(entry.edited || false)
  const [displayOrig,       setDisplayOrig]       = useState((entry.original_text  || '').trim())
  const [displayTrans,      setDisplayTrans]      = useState((entry.translated_text || '').trim())
  const [displaySourceLang, setDisplaySourceLang] = useState(entry.source_lang || 'AUTO')
  const [displayTargetLang, setDisplayTargetLang] = useState(entry.target_lang || 'EN')
  const [retranslating,     setRetranslating]     = useState(false)

  const handleCopy = () => {
    navigator.clipboard?.writeText(entry.translated_text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handlePlay = async () => {
    if (muted) return
    const text = displayTrans
    if (!text) return
    setPlaying(true)
    try {
      if (entry.audio_url && !isEdited) {
        await playAudioUrl(entry.audio_url)
      } else {
        const r = await fetch(`${API_BASE_URL}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, lang: displayTargetLang.toLowerCase() }),
        })
        const d = await r.json()
        if (d.audio_url) await playAudioUrl(d.audio_url)
        else speakText(text, displayTargetLang)
      }
    } catch {
      speakText(text, displayTargetLang)
    }
    setPlaying(false)
  }

  const handleEditSave = async () => {
    const trimmed = editValue.trim()
    setEditing(false)
    if (!trimmed || trimmed === displayOrig) return
    setDisplayOrig(trimmed)
    setIsEdited(true)

    // Build updates object — will be enriched after re-translation
    const updates = {
      original_text:   trimmed,
      translated_text: displayTrans,
      source_lang:     displaySourceLang.toLowerCase(),
      target_lang:     displayTargetLang.toLowerCase(),
    }

    if (onRetranslate) {
      setRetranslating(true)
      try {
        const result = await onRetranslate(trimmed)
        if (result?.translated_text) {
          updates.translated_text = result.translated_text
          setDisplayTrans(result.translated_text)
          if (result.lang) {
            updates.target_lang = result.lang.toLowerCase()
            setDisplayTargetLang(result.lang.toUpperCase())
          }
          if (result.source_lang && result.source_lang !== 'auto') {
            updates.source_lang = result.source_lang.toLowerCase()
            setDisplaySourceLang(result.source_lang.toUpperCase())
          }
        }
      } catch {}
      finally {
        setRetranslating(false)
        onSaveEdit?.(entry.client_entry_id, updates)
      }
    } else {
      onSaveEdit?.(entry.client_entry_id, updates)
    }
  }

  const handleEditCancel = () => {
    setEditValue(displayOrig)
    setEditing(false)
  }

  const origText  = displayOrig
  const transText = displayTrans
  const hasText   = origText || transText

  return (
    <div className="tcard">
      <div className="tcard-original">
        <div className="tcard-badges">
          <span className="badge badge-auto">{displaySourceLang.toUpperCase()}</span>
          <span className="badge-label">ORIGINAL</span>
          {isEdited && <span className="tcard-edited-badge">Edited</span>}
          <div style={{flex:1}}/>
          {!editing && (
            <button className="tcard-edit-btn" onClick={() => setEditing(true)} title="Edit original text">
              <IconEdit size={12}/>
            </button>
          )}
        </div>
        {editing ? (
          <div className="tcard-edit-wrap">
            <textarea
              className="tcard-edit-input"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              autoFocus
              rows={2}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSave() }
                if (e.key === 'Escape') handleEditCancel()
              }}
            />
            <div className="tcard-edit-actions">
              <button className="tcard-edit-save" onClick={handleEditSave}>Save</button>
              <button className="tcard-edit-cancel" onClick={handleEditCancel}>Cancel</button>
            </div>
          </div>
        ) : (
          <p className="tcard-text">
            {origText || <span style={{opacity:.35,fontStyle:'italic'}}>—</span>}
          </p>
        )}
      </div>
      <div className="tcard-translation">
        <div className="tcard-badges">
          <span className="badge badge-lang">{displayTargetLang.toUpperCase()}</span>
          <span className="badge-label">TRANSLATION</span>
          {entry.created_at && (
            <span className="tcard-time">
              <IconClock />
              {new Date(entry.created_at).toLocaleString('ro-RO', {
                day:'2-digit', month:'2-digit', year:'numeric',
                hour:'2-digit', minute:'2-digit', second:'2-digit'
              })}
            </span>
          )}
        </div>
        <p className="tcard-text tcard-text--translated">
          {retranslating
            ? <span style={{opacity:.45,fontStyle:'italic'}}>Translating…</span>
            : transText || <span style={{opacity:.35,fontStyle:'italic'}}>—</span>}
        </p>
        <div className="tcard-actions">
          <button className="icon-btn" onClick={handleCopy} title="Copy"
            disabled={!hasText || retranslating} style={(!hasText || retranslating) ? {opacity:.3} : {}}>
            {copied
              ? <span style={{fontSize:'11px',fontWeight:700,color:'var(--color-success)'}}>✓</span>
              : <IconCopy />}
          </button>
          <button
            className={`icon-btn ${muted || !transText ? 'icon-btn--muted' : ''} ${playing ? 'icon-btn--active' : ''}`}
            onClick={handlePlay}
            disabled={!transText || playing || retranslating}
            title={playing ? 'Playing…' : retranslating ? 'Translating…' : muted ? 'TTS muted — change in Settings' : !transText ? 'No translation available' : 'Play translation'}
          >
            {muted ? <IconMute /> : <IconVolume />}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── ProfilePage ──────────────────────────────────────────────────────────────
function detectCountryFromLocale() {
  const locale = navigator.language || navigator.userLanguage || ''
  const parts = locale.split('-')
  return parts.length >= 2 ? parts[parts.length - 1].toUpperCase() : ''
}

function ProfilePage({ authUser, authToken, onBack, onGoHistory, onUserUpdate, onAvatarChange, onModeChange }) {
  const [editing,  setEditing]  = useState(null)
  const [mainLang, setMainLang] = useState(
    authUser?.main_language || localStorage.getItem('translator_main_lang') || ''
  )
  const [country,  setCountry]  = useState(
    authUser?.country ||
    localStorage.getItem(`user_country_${authUser?.id}`) ||
    ''
  )
  // Timezone is auto-detected — never editable, never sent to backend
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')
  const [prefMode,    setPrefMode]    = useState(authUser?.preferred_mode || localStorage.getItem('translation_mode') || 'speech-speech')
  const [editingMode, setEditingMode] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState(null)

  const PROFILE_MODES = [
    { id: 'speech-speech', label: 'Speech to Speech', sub: 'Speak & hear',
      icon: <><Mic size={18}/><span style={{opacity:.45,fontSize:'11px',margin:'0 2px'}}>→</span><Volume2 size={18}/></> },
    { id: 'speech-text',   label: 'Speech to Text',   sub: 'Speak & read',
      icon: <><Mic size={18}/><span style={{opacity:.45,fontSize:'11px',margin:'0 2px'}}>→</span><FileText size={18}/></> },
    { id: 'text-text',     label: 'Text to Text',     sub: 'Type & read',
      icon: <><Keyboard size={18}/><span style={{opacity:.45,fontSize:'11px',margin:'0 2px'}}>→</span><FileText size={18}/></> },
    { id: 'text-speech',   label: 'Text to Speech',   sub: 'Type & hear',
      icon: <><Keyboard size={18}/><span style={{opacity:.45,fontSize:'11px',margin:'0 2px'}}>→</span><Volume2 size={18}/></> },
  ]
  const MODE_LABEL = { 'speech-speech':'Speech to Speech', 'speech-text':'Speech to Text', 'text-text':'Text to Text', 'text-speech':'Text to Speech' }

  const saveMode = async () => {
    setSaving(true); setError('')
    try {
      const { data, error: sbErr } = await supabase.auth.updateUser({ data: { preferred_mode: prefMode } })
      if (sbErr) { setError(sbErr.message); return }
      onUserUpdate(data.user)
      onModeChange?.(prefMode)
      setEditingMode(false)
    } catch { setError('Server error') }
    finally { setSaving(false) }
  }
  const fileRef = useRef(null)

  const memberSince = authUser?.created_at
    ? new Date(authUser.created_at).toLocaleDateString('en-US', { month:'long', year:'numeric' })
    : 'Unknown'

  useEffect(() => {
    const saved = localStorage.getItem(`avatar_${authUser?.id}`)
    if (saved) setAvatarUrl(saved)
  }, [authUser?.id])

  const handleAvatarChange = e => {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const data = ev.target.result
      setAvatarUrl(data)
      localStorage.setItem(`avatar_${authUser.id}`, data)
      onAvatarChange?.(data)
    }
    reader.readAsDataURL(file)
  }

  const saveField = async (field, value) => {
    setSaving(true); setError('')
    try {
      let normalizedValue = value.trim()

      // Country: normalize via Groq, save to localStorage only (no DB column yet)
      if (field === 'country') {
        if (normalizedValue) {
          try {
            const nr = await fetch(`${API_BASE_URL}/normalize_country`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: normalizedValue }),
            })
            const nd = await nr.json()
            if (nd.iso_code) normalizedValue = nd.iso_code
            else normalizedValue = normalizedValue.toUpperCase().slice(0, 2)
          } catch {
            normalizedValue = normalizedValue.toUpperCase().slice(0, 2)
          }
        }
        localStorage.setItem(`user_country_${authUser?.id}`, normalizedValue)
        setCountry(normalizedValue)
        setEditing(null)
        return
      }

      // Language: normalize via Groq, save to backend
      if (field === 'lang' && normalizedValue) {
        try {
          const nr = await fetch(`${API_BASE_URL}/normalize_language`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: normalizedValue }),
          })
          const nd = await nr.json()
          if (nd.iso_code) normalizedValue = nd.iso_code
          else normalizedValue = normalizedValue.toLowerCase().slice(0, 2)
        } catch {
          normalizedValue = normalizedValue.toLowerCase().slice(0, 2)
        }
      }

      const { data, error: sbErr } = await supabase.auth.updateUser({
        data: { main_language: normalizedValue || null }
      })
      if (sbErr) { setError(sbErr.message); return }
      onUserUpdate(data.user)
      const lang = normalizedValue || ''
      setMainLang(lang)
      if (lang) localStorage.setItem('translator_main_lang', lang)
      setEditing(null)
    } catch { setError('Server error — check console') }
    finally { setSaving(false) }
  }

  const EditRow = ({ icon, label, value, fieldKey, setter, currentVal, readOnly = false }) => (
    <div className="profile-row">
      <div className="profile-row-left">
        <span className="profile-row-icon">{icon}</span>
        <div style={{ flex:1, minWidth:0 }}>
          <div className="profile-row-label">{label}</div>
          {!readOnly && editing === fieldKey ? (
            <input className="profile-edit-input" value={currentVal}
              onChange={e => setter(e.target.value)} autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter')  saveField(fieldKey, currentVal)
                if (e.key === 'Escape') setEditing(null)
              }} />
          ) : (
            <div className="profile-row-value">{value || <span style={{opacity:.4}}>Not set</span>}</div>
          )}
        </div>
      </div>
      <div className="profile-row-right">
        {!readOnly && (editing === fieldKey ? (
          <>
            <button className="profile-save-btn" onClick={() => saveField(fieldKey, currentVal)} disabled={saving}>
              {saving ? '…' : 'Save'}
            </button>
            <button className="profile-cancel-btn" onClick={() => setEditing(null)}>Cancel</button>
          </>
        ) : (
          <button className="icon-btn" onClick={() => setEditing(fieldKey)}><IconEdit /></button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="page-inner">
      <div className="page-header">
        <h2 className="page-title">Profile</h2>
        <button className="back-btn" onClick={onBack}>← Back</button>
      </div>

      <div className="profile-card">
        {/* Avatar */}
        <div className="profile-avatar-row">
          <div className="profile-avatar-wrap">
            <div className="profile-avatar">
              {avatarUrl
                ? <img src={avatarUrl} alt="avatar" style={{width:'100%',height:'100%',objectFit:'cover',borderRadius:'50%'}} />
                : <IconUser size={28} />}
            </div>
            <button className="avatar-camera-btn" onClick={() => fileRef.current?.click()} title="Change photo">
              <IconCamera />
            </button>
            <input ref={fileRef} type="file" accept="image/*" style={{display:'none'}} onChange={handleAvatarChange} />
          </div>
          <div>
            <div className="profile-username">{authUser?.username}</div>
            <div className="profile-since">Member since {memberSince}</div>
          </div>
        </div>

        {error && <p className="profile-error">{error}</p>}

        <EditRow icon={<IconTranslate />} label="Native language"
          value={getLangName(mainLang) + (mainLang ? ` (${mainLang.toUpperCase()})` : '')}
          fieldKey="lang" setter={setMainLang} currentVal={mainLang} />

        <EditRow icon={<IconMapPin />} label="Country you live in / Frequently translating into"
          value={getCountryDisplay(country)}
          fieldKey="country" setter={setCountry} currentVal={country} />

        {/* Timezone — read-only, auto from device */}
        <EditRow icon={<IconGlobe />} label="Timezone (auto-detected)"
          value={timezone} fieldKey="timezone" readOnly />

        {/* Preferred translation mode */}
        <div className={`profile-row profile-row--mode ${editingMode ? 'profile-row--mode-open' : ''}`}>
          <div className="profile-mode-header">
            <div className="profile-row-left">
              <span className="profile-row-icon"><IconSettings /></span>
              <div style={{flex:1,minWidth:0}}>
                <div className="profile-row-label">Preferred translation mode</div>
                {!editingMode && (
                  <div className="profile-row-value">{MODE_LABEL[prefMode] || <span style={{opacity:.4}}>Not set</span>}</div>
                )}
              </div>
            </div>
            <div className="profile-row-right">
              {editingMode ? (
                <>
                  <button className="profile-save-btn" onClick={saveMode} disabled={saving}>{saving ? '…' : 'Save'}</button>
                  <button className="profile-cancel-btn" onClick={() => { setEditingMode(false); setPrefMode(authUser?.preferred_mode || localStorage.getItem('translation_mode') || 'speech-speech') }}>Cancel</button>
                </>
              ) : (
                <button className="icon-btn" onClick={() => setEditingMode(true)}><IconEdit /></button>
              )}
            </div>
          </div>
          {editingMode && (
            <div className="mode-selector mode-selector--4 profile-mode-grid">
              {PROFILE_MODES.map(m => (
                <button key={m.id} type="button"
                  className={`mode-card ${prefMode === m.id ? 'mode-card--active' : ''}`}
                  onClick={() => setPrefMode(m.id)}>
                  <div className="mode-card-icon">{m.icon}</div>
                  <div className="mode-card-texts">
                    <div className="mode-card-title">{m.label}</div>
                    <div className="mode-card-sub">{m.sub}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="profile-card profile-history-link" onClick={onGoHistory}>
        <div className="profile-row" style={{border:'none',padding:0}}>
          <div className="profile-row-left">
            <span className="profile-row-icon"><IconHistory /></span>
            <div>
              <div style={{fontSize:'0.95rem',fontWeight:700,color:'var(--text-primary)'}}>Translation History</div>
              <div style={{fontSize:'0.82rem',color:'var(--text-muted)',marginTop:2}}>View your past conversations</div>
            </div>
          </div>
          <IconChevR />
        </div>
      </div>
    </div>
  )
}

// ─── HistoryPage ──────────────────────────────────────────────────────────────
const LS_OPEN  = 'hist_open_days'
const LS_NAMES = 'hist_day_names'

function HistoryPage({ authToken, muted, onBack, onRetranslate, onSaveEdit }) {
  const [entries,    setEntries]    = useState([])
  const [loading,    setLoading]    = useState(true)

  // Update a card in local history + propagate to DB via parent
  const handleSaveEditHistory = (clientEntryId, updates) => {
    setEntries(prev => prev.map(e =>
      e.client_entry_id === clientEntryId ? { ...e, ...updates, edited: true } : e
    ))
    onSaveEdit?.(clientEntryId, updates)
  }
  const [openDays,   setOpenDays]   = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_OPEN) || '{}') } catch { return {} }
  })
  const [dayNames,   setDayNames]   = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_NAMES) || '{}') } catch { return {} }
  })
  const [editingDay, setEditingDay] = useState(null)
  const [editName,   setEditName]   = useState('')

  useEffect(() => { localStorage.setItem(LS_OPEN,  JSON.stringify(openDays))  }, [openDays])
  useEffect(() => { localStorage.setItem(LS_NAMES, JSON.stringify(dayNames))  }, [dayNames])

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch(`${API_BASE_URL}/history`, {
          headers: { Authorization: `Bearer ${authToken}` }
        })
        const d = await r.json()
        if (d.status === 'success') {
          const list = d.entries || []
          console.log(`[DB] Istoric: ${list.length} intrări găsite în Supabase`)
          setEntries(list)
          if (list.length) {
            const firstDay = new Date(list[0].created_at).toLocaleDateString('ro-RO')
            setOpenDays(prev =>
              typeof prev[firstDay] === 'undefined' ? { ...prev, [firstDay]: true } : prev
            )
          }
        }
      } catch {}
      finally { setLoading(false) }
    }
    load()
  }, [authToken])

  // Group entries by local date
  const grouped = entries.reduce((acc, e) => {
    const k = new Date(e.created_at).toLocaleDateString('ro-RO')
    if (!acc[k]) acc[k] = []
    acc[k].push(e); return acc
  }, {})

  const toggleDay    = (day) => setOpenDays(p => ({ ...p, [day]: !p[day] }))
  const startRename  = (e, day) => { e.stopPropagation(); setEditingDay(day); setEditName(dayNames[day] || '') }
  const confirmRename= (e, day) => { e.stopPropagation(); setDayNames(p => ({ ...p, [day]: editName.trim() })); setEditingDay(null) }
  const cancelRename = (e)       => { e.stopPropagation(); setEditingDay(null) }

  return (
    <div className="page-inner hist-page-inner">
      <div className="page-header">
        <div>
          <h2 className="page-title">Translation History</h2>
          <p className="page-subtitle">View your past conversations</p>
        </div>
        <button className="back-btn" onClick={onBack}>← Back</button>
      </div>

      {loading ? (
        <div className="hint-center">Loading history…</div>
      ) : entries.length === 0 ? (
        <div className="hint-center">No saved entries yet.</div>
      ) : (
        /* Outer: scrolls through all day-groups */
        <div className="hist-outer-scroll">
          {Object.entries(grouped).map(([day, dayEntries]) => (
            <div key={day} className="history-group">

              {/* Day header */}
              <div className="history-group-header" onClick={() => toggleDay(day)}>
                <div className="history-group-left">
                  <span className="history-chevron">
                    {openDays[day] ? <IconChevD /> : <IconChevR />}
                  </span>

                  {editingDay === day ? (
                    <div className="day-rename-wrap" onClick={e => e.stopPropagation()}>
                      <span className="history-day-date">{day}</span>
                      <span className="history-day-sep"> — </span>
                      <input className="day-rename-input" value={editName} autoFocus
                        placeholder="Conversation name…"
                        onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter')  confirmRename(e, day)
                          if (e.key === 'Escape') cancelRename(e)
                        }} />
                      <button className="rename-save-btn"   onClick={e => confirmRename(e, day)}>Save</button>
                      <button className="rename-cancel-btn" onClick={cancelRename}>✕</button>
                    </div>
                  ) : (
                    <span className="history-day-label">
                      {day}
                      {dayNames[day] && <> — <span className="history-day-custom">{dayNames[day]}</span></>}
                    </span>
                  )}
                </div>

                <div className="history-group-right">
                  <span className="history-count">{dayEntries.length} translations</span>
                  {editingDay !== day && (
                    <button className="icon-btn history-edit-btn"
                      onClick={e => startRename(e, day)} title="Rename">
                      <IconEdit size={13} />
                    </button>
                  )}
                </div>
              </div>

              {/* Inner: scrolls through this day's cards */}
              {openDays[day] && (
                <div className="hist-inner-scroll">
                  {dayEntries.map((e, i) => (
                    <TranslationCard key={e.client_entry_id || i} entry={e} muted={muted} onRetranslate={onRetranslate} onSaveEdit={handleSaveEditHistory} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── AuthModal ────────────────────────────────────────────────────────────────
function AuthModal({ initialMode = 'login', onClose, onModeChange }) {
  const [mode,     setMode]     = useState(initialMode)
  const [step,     setStep]     = useState(1) // 1 = credentials, 2 = optional profile (signup only)
  const [form,     setForm]     = useState({ username:'', email:'', password:'', main_language:'', country:'', preferred_mode:'speech-speech' })
  const [msg,      setMsg]      = useState({ text:'', ok: false })
  const [loading,  setLoading]  = useState(false)
  const [showPass, setShowPass] = useState(false)
  const set = (f, v) => setForm(p => ({ ...p, [f]: v }))

  const SIGNUP_MODES = [
    { id: 'speech-speech', label: 'Speech to Speech', sub: 'Speak & hear',
      icon: <><Mic size={20}/><span style={{opacity:.45,fontSize:'12px',margin:'0 2px'}}>→</span><Volume2 size={20}/></> },
    { id: 'speech-text',   label: 'Speech to Text',   sub: 'Speak & read',
      icon: <><Mic size={20}/><span style={{opacity:.45,fontSize:'12px',margin:'0 2px'}}>→</span><FileText size={20}/></> },
    { id: 'text-text',     label: 'Text to Text',     sub: 'Type & read',
      icon: <><Keyboard size={20}/><span style={{opacity:.45,fontSize:'12px',margin:'0 2px'}}>→</span><FileText size={20}/></> },
    { id: 'text-speech',   label: 'Text to Speech',   sub: 'Type & hear',
      icon: <><Keyboard size={20}/><span style={{opacity:.45,fontSize:'12px',margin:'0 2px'}}>→</span><Volume2 size={20}/></> },
  ]

  // ── Step 1: validate & advance ─────────────────────────────────────────────
  const handleContinue = () => {
    setMsg({ text:'', ok:false })
    if (!form.username.trim() || form.username.trim().length < 3) {
      setMsg({ text:'Username must be at least 3 characters', ok:false }); return
    }
    if (!form.email.includes('@')) {
      setMsg({ text:'Please enter a valid email address', ok:false }); return
    }
    if (!form.password || form.password.length < 6) {
      setMsg({ text:'Password must be at least 6 characters', ok:false }); return
    }
    setStep(2)
  }

  // ── Step 2: create account (skipOptional skips optional fields) ────────────
  const handleSignup = async (skipOptional = false) => {
    setMsg({ text:'', ok:false }); setLoading(true)
    const meta = {
      username:       form.username.trim(),
      main_language:  (!skipOptional && form.main_language.trim()) ? form.main_language.trim() : null,
      country:        (!skipOptional && form.country.trim())        ? form.country.trim().toUpperCase() : null,
      preferred_mode: (!skipOptional && form.preferred_mode)        ? form.preferred_mode : null,
    }
    const { error: signUpError } = await supabase.auth.signUp({
      email: form.email, password: form.password,
      options: { data: meta },
    })
    if (signUpError) { setLoading(false); setMsg({ text: signUpError.message, ok:false }); return }
    // Try auto-login (works when email confirmation is disabled)
    const { error: loginError } = await supabase.auth.signInWithPassword({ email: form.email, password: form.password })
    setLoading(false)
    if (!loginError) {
      // Apply preferred mode immediately (don't wait for onAuthStateChange timing)
      if (meta.preferred_mode) onModeChange?.(meta.preferred_mode)
      onClose(); return
    }
    if (loginError.message?.toLowerCase().includes('email not confirmed')) {
      setMsg({ text:'Account created! Check your inbox for a confirmation email, then log in.', ok:true })
    } else {
      setMsg({ text:'Account created! You can now log in.', ok:true })
    }
    setMode('login'); setStep(1)
  }

  // ── Login ──────────────────────────────────────────────────────────────────
  const handleLogin = async () => {
    setMsg({ text:'', ok:false }); setLoading(true)
    if (!form.email.includes('@')) {
      setMsg({ text:'Enter your email address (not your username)', ok:false }); setLoading(false); return
    }
    const { error } = await supabase.auth.signInWithPassword({ email: form.email, password: form.password })
    setLoading(false)
    if (error) {
      const m = error.message?.toLowerCase()
      if (m?.includes('invalid login credentials') || m?.includes('invalid credentials')) {
        setMsg({ text:'Wrong email or password. Check your details and try again.', ok:false })
      } else if (m?.includes('email not confirmed')) {
        setMsg({ text:'Please confirm your email first — check your inbox.', ok:false })
      } else {
        setMsg({ text: error.message, ok:false })
      }
      return
    }
    onClose()
  }

  // ── Forgot ─────────────────────────────────────────────────────────────────
  const handleForgot = async () => {
    if (!form.email) { setMsg({ text:'Enter your email first', ok:false }); return }
    setLoading(true)
    const { error } = await supabase.auth.resetPasswordForEmail(form.email, { redirectTo: window.location.origin })
    setLoading(false)
    if (error) { setMsg({ text: error.message, ok:false }); return }
    setMsg({ text:'Password reset email sent! Check your inbox.', ok:true })
  }

  const switchMode = (m) => { setMode(m); setStep(1); setMsg({ text:'', ok:false }) }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>

        {/* ── Tabs: only show on step 1 / non-signup ── */}
        {mode !== 'forgot' && !(mode === 'signup' && step === 2) && (
          <div className="modal-tabs">
            <button className={`modal-tab ${mode==='login'?'active':''}`}  onClick={() => switchMode('login')}>Login</button>
            <button className={`modal-tab ${mode==='signup'?'active':''}`} onClick={() => switchMode('signup')}>Sign up</button>
          </div>
        )}

        {/* ── Forgot: title ── */}
        {mode === 'forgot' && (
          <h3 className="modal-title" style={{marginBottom:12}}>Reset password</h3>
        )}

        {/* ══════════════════════════════════════
            SIGNUP — Step 1: Credentials
        ══════════════════════════════════════ */}
        {mode === 'signup' && step === 1 && (
          <>
            <div className="signup-step-indicator">
              <span className="signup-step-dot signup-step-dot--active">1</span>
              <span className="signup-step-line"/>
              <span className="signup-step-dot signup-step-dot--pending">2</span>
            </div>
            <input className="field" placeholder="Username (min 3 characters)"
              value={form.username} onChange={e => set('username', e.target.value)} autoFocus />
            <input className="field" placeholder="Email address (e.g. you@example.com)" type="email"
              value={form.email} onChange={e => set('email', e.target.value)} />
            <div className="field-password-wrap">
              <input className="field" type={showPass ? 'text' : 'password'}
                placeholder="Password (min 6 characters)" value={form.password}
                onChange={e => set('password', e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleContinue() }} />
              <button className="field-eye-btn" type="button" onClick={() => setShowPass(p => !p)}
                title={showPass ? 'Hide password' : 'Show password'}>
                {showPass ? <EyeOff size={15}/> : <Eye size={15}/>}
              </button>
            </div>
            {msg.text && <p className={`auth-msg ${msg.ok ? 'auth-success' : 'auth-error'}`}>{msg.text}</p>}
            <button className="modal-submit" onClick={handleContinue}>Continue →</button>
          </>
        )}

        {/* ══════════════════════════════════════
            SIGNUP — Step 2: Optional profile
        ══════════════════════════════════════ */}
        {mode === 'signup' && step === 2 && (
          <>
            <div className="signup-step2-header">
              <div className="signup-step-indicator">
                <span className="signup-step-dot signup-step-dot--done">1</span>
                <span className="signup-step-line"/>
                <span className="signup-step-dot signup-step-dot--active">2</span>
              </div>
              <h3 className="modal-title" style={{marginBottom:4}}>Complete your profile</h3>
              <p className="signup-step2-sub">All fields are optional — feel free to skip</p>
            </div>

            <input className="field" placeholder="Native language (e.g. Romanian, English, ro, en)"
              value={form.main_language} onChange={e => set('main_language', e.target.value)} autoFocus />
            <input className="field" placeholder="Country (e.g. Romania, RO, United States)"
              value={form.country} onChange={e => set('country', e.target.value)} />
            <div className="signup-mode-wrap">
              <div className="signup-mode-label">Preferred translation mode <span>(optional)</span></div>
              <div className="mode-selector mode-selector--4 signup-mode-grid">
                {SIGNUP_MODES.map(m => (
                  <button key={m.id} type="button"
                    className={`mode-card ${form.preferred_mode === m.id ? 'mode-card--active' : ''}`}
                    onClick={() => set('preferred_mode', form.preferred_mode === m.id ? '' : m.id)}>
                    <div className="mode-card-icon">{m.icon}</div>
                    <div className="mode-card-texts">
                      <div className="mode-card-title">{m.label}</div>
                      <div className="mode-card-sub">{m.sub}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {msg.text && <p className={`auth-msg ${msg.ok ? 'auth-success' : 'auth-error'}`}>{msg.text}</p>}

            <div className="signup-step2-actions">
              <button className="signup-skip-btn" onClick={() => handleSignup(true)} disabled={loading}>
                Skip
              </button>
              <button className="modal-submit signup-create-btn" onClick={() => handleSignup(false)} disabled={loading}>
                {loading ? 'Creating…' : 'Create account'}
              </button>
            </div>
            <button className="auth-forgot-btn" style={{marginTop:2}}
              onClick={() => { setStep(1); setMsg({ text:'', ok:false }) }}>
              ← Back
            </button>
          </>
        )}

        {/* ══════════════════════════════════════
            LOGIN & FORGOT
        ══════════════════════════════════════ */}
        {mode !== 'signup' && (
          <>
            <input className="field" placeholder="Email address (e.g. you@example.com)" type="email"
              value={form.email} onChange={e => set('email', e.target.value)} />
            {mode !== 'forgot' && (
              <div className="field-password-wrap">
                <input className="field" type={showPass ? 'text' : 'password'}
                  placeholder="Password" value={form.password}
                  onChange={e => set('password', e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleLogin() }} />
                <button className="field-eye-btn" type="button" onClick={() => setShowPass(p => !p)}
                  title={showPass ? 'Hide password' : 'Show password'}>
                  {showPass ? <EyeOff size={15}/> : <Eye size={15}/>}
                </button>
              </div>
            )}
            {mode === 'login' && (
              <button className="auth-forgot-btn" onClick={() => switchMode('forgot')}>Forgot password?</button>
            )}
            {msg.text && <p className={`auth-msg ${msg.ok ? 'auth-success' : 'auth-error'}`}>{msg.text}</p>}
            <button className="modal-submit"
              onClick={mode === 'forgot' ? handleForgot : handleLogin}
              disabled={loading}>
              {loading ? 'Please wait…' : mode === 'forgot' ? 'Send reset email' : 'Login'}
            </button>
            {mode === 'forgot' && (
              <button className="auth-forgot-btn" style={{marginTop:8}} onClick={() => switchMode('login')}>
                ← Back to login
              </button>
            )}
          </>
        )}

      </div>
    </div>
  )
}

// ─── ResetPasswordModal ───────────────────────────────────────────────────────
function ResetPasswordModal({ onDone }) {
  const [password,  setPassword]  = useState('')
  const [password2, setPassword2] = useState('')
  const [msg,       setMsg]       = useState({ text:'', ok:false })
  const [loading,   setLoading]   = useState(false)
  const [showPass,  setShowPass]  = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (password.length < 6) { setMsg({ text:'Password must be at least 6 characters', ok:false }); return }
    if (password !== password2) { setMsg({ text:'Passwords do not match', ok:false }); return }
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) { setMsg({ text: error.message, ok:false }); return }
    setMsg({ text:'Password updated! Redirecting…', ok:true })
    setTimeout(onDone, 1500)
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3 className="modal-title" style={{marginBottom:12}}>Set new password</h3>
        <form onSubmit={handleSubmit} style={{display:'flex',flexDirection:'column',gap:10}}>
          <div className="field-password-wrap">
            <input className="field" type={showPass ? 'text' : 'password'}
              placeholder="New password" value={password}
              onChange={e => setPassword(e.target.value)} autoFocus />
            <button className="field-eye-btn" type="button" onClick={() => setShowPass(p => !p)}>
              {showPass ? <EyeOff size={15}/> : <Eye size={15}/>}
            </button>
          </div>
          <div className="field-password-wrap">
            <input className="field" type={showPass ? 'text' : 'password'}
              placeholder="Confirm new password" value={password2}
              onChange={e => setPassword2(e.target.value)} />
          </div>
          {msg.text && (
            <p className={`auth-msg ${msg.ok ? 'auth-success' : 'auth-error'}`}>{msg.text}</p>
          )}
          <button className="modal-submit" type="submit" disabled={loading}>
            {loading ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ─── SettingsModal ────────────────────────────────────────────────────────────
function SettingsModal({ translationMode, onModeChange, onClose }) {
  const MODES = [
    { id: 'speech-speech', label: 'Speech to Speech', sub: 'Speak & hear',
      icon: <><Mic size={20}/><span style={{opacity:.45,fontSize:'12px',margin:'0 2px'}}>→</span><Volume2 size={20}/></> },
    { id: 'speech-text',   label: 'Speech to Text',   sub: 'Speak & read',
      icon: <><Mic size={20}/><span style={{opacity:.45,fontSize:'12px',margin:'0 2px'}}>→</span><FileText size={20}/></> },
    { id: 'text-text',     label: 'Text to Text',     sub: 'Type & read',
      icon: <><Keyboard size={20}/><span style={{opacity:.45,fontSize:'12px',margin:'0 2px'}}>→</span><FileText size={20}/></> },
    { id: 'text-speech',   label: 'Text to Speech',   sub: 'Type & hear',
      icon: <><Keyboard size={20}/><span style={{opacity:.45,fontSize:'12px',margin:'0 2px'}}>→</span><Volume2 size={20}/></> },
  ]
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3 className="modal-title">Settings</h3>
        <div className="settings-section-label">Translation Mode</div>
        <p className="settings-section-sub">Choose how you want to translate</p>
        <div className="mode-selector mode-selector--4">
          {MODES.map(m => (
            <button key={m.id}
              className={`mode-card ${translationMode === m.id ? 'mode-card--active' : ''}`}
              onClick={() => onModeChange(m.id)}>
              <div className="mode-card-icon">{m.icon}</div>
              <div className="mode-card-texts">
                <div className="mode-card-title">{m.label}</div>
                <div className="mode-card-sub">{m.sub}</div>
              </div>
            </button>
          ))}
        </div>
        <button className="modal-submit" onClick={onClose} style={{marginTop:12}}>Done</button>
      </div>
    </div>
  )
}

// ─── Dropdowns ────────────────────────────────────────────────────────────────
function useOutsideClose(ref, onClose) {
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    setTimeout(() => document.addEventListener('mousedown', h), 0)
    return () => document.removeEventListener('mousedown', h)
  }, [onClose, ref])
}

function UserDropdown({ authUser, avatarUrl, onProfile, onSettings, onLogout, onClose }) {
  const ref = useRef(null); useOutsideClose(ref, onClose)
  return (
    <div className="dropdown" ref={ref}>
      <div className="dropdown-header">
        <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'6px' }}>
          <div style={{ width:38, height:38, borderRadius:'50%', overflow:'hidden', flexShrink:0, background:'var(--color-surface2, #2a2d3a)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'16px', fontWeight:600 }}>
            {avatarUrl
              ? <img src={avatarUrl} alt="avatar" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
              : authUser.username?.[0]?.toUpperCase()}
          </div>
          <div>
            <div className="dropdown-username">{authUser.username}</div>
            <div style={{ fontSize:'11px', opacity:0.55, marginTop:'1px', wordBreak:'break-all', lineHeight:1.4 }}>{authUser.email}</div>
          </div>
        </div>
      </div>
      <div className="dropdown-divider"/>
      <button className="dropdown-item" onClick={() => { onProfile(); onClose() }}><IconProfile/> View Profile</button>
      <button className="dropdown-item" onClick={() => { onSettings(); onClose() }}><IconSettings/> Settings</button>
      <div className="dropdown-divider"/>
      <button className="dropdown-item dropdown-item--danger" onClick={() => { onLogout(); onClose() }}><IconLogout/> Logout</button>
    </div>
  )
}

function GuestDropdown({ onLogin, onSignup, onSettings, onClose }) {
  const ref = useRef(null); useOutsideClose(ref, onClose)
  return (
    <div className="dropdown" ref={ref}>
      <div className="dropdown-header">
        <div className="dropdown-username" style={{opacity:.55,fontSize:'0.82rem'}}>Not signed in</div>
      </div>
      <div className="dropdown-divider"/>
      <button className="dropdown-item" onClick={() => { onLogin();    onClose() }}><IconSignIn/>   Login</button>
      <button className="dropdown-item" onClick={() => { onSignup();   onClose() }}><IconUserPlus/> Sign up</button>
      <div className="dropdown-divider"/>
      <button className="dropdown-item" onClick={() => { onSettings(); onClose() }}><IconSettings/> Settings</button>
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [theme, toggleTheme]       = useTheme()
  const [muted, mutedRef, toggleMute, setMuted] = useMute()

  const [authUser,  setAuthUser]  = useState(null)
  const [authToken, _setAuthToken] = useState('')
  const authTokenRef = useRef('')
  const setAuthToken = (t) => { authTokenRef.current = t; _setAuthToken(t) }
  const [headerAvatarUrl,   setHeaderAvatarUrl]   = useState(null)
  const [showDropdown,      setShowDropdown]      = useState(false)
  const [showAuth,          setShowAuth]          = useState(false)
  const [authInitMode,      setAuthInitMode]      = useState('login')
  const [showSettings,      setShowSettings]      = useState(false)
  const [showResetPassword, setShowResetPassword] = useState(false)
  const [page,              setPage]              = useState('main')

  // Normalize Supabase user → shape the rest of the app expects
  const normalizeUser = (u) => u ? {
    id:             u.id,
    email:          u.email,
    username:       u.user_metadata?.username || u.email?.split('@')[0] || 'User',
    main_language:  u.user_metadata?.main_language || '',
    country:        u.user_metadata?.country || null,
    preferred_mode: u.user_metadata?.preferred_mode || null,
    created_at:     u.created_at || null,
  } : null

  // Language context — derived from user profile + localStorage
  const nativeLang = authUser?.main_language || localStorage.getItem('translator_main_lang') || ''
  const storedCountry = (
    authUser?.id ? (localStorage.getItem(`user_country_${authUser.id}`) || '') : ''
  ).toUpperCase()
  const countryLang = countryToLang(storedCountry)
  // Default target: native lang if set, else country lang, else 'en'
  const targetLang = nativeLang || countryLang || 'en'

  // Translation mode — persisted (4 modes: speech-speech, speech-text, text-text, text-speech)
  const [translationMode, setTranslationMode] = useState(() => {
    const m = localStorage.getItem('translation_mode') || 'speech-speech'
    if (m === 'speech') return 'speech-speech' // migrate old value
    if (m === 'text')   return 'text-text'      // migrate old value
    return m
  })
  const isSpeechInput = translationMode.startsWith('speech')
  const isSpeechOutput = translationMode.endsWith('speech')

  const changeMode = (m) => {
    setTranslationMode(m)
    localStorage.setItem('translation_mode', m)
    setMuted(!m.endsWith('speech'))
    // Stop microphone if switching to a text-input mode
    if (!m.startsWith('speech') && isListening) stopListening()
    // Persist preference to Supabase profile (fire-and-forget)
    if (authUser) supabase.auth.updateUser({ data: { preferred_mode: m } }).catch(() => {})
  }

  // Sync muted with mode on mount
  useEffect(() => { setMuted(!translationMode.endsWith('speech')) }, []) // eslint-disable-line

  // Translator state
  const [isListening,  setIsListening]  = useState(false)
  const [isFinalizing, setIsFinalizing] = useState(false)
  const [isVoiceActive, setIsVoiceActive] = useState(false)
  const isVoiceActiveRef = useRef(false)
  const setVoiceActive = (v) => { isVoiceActiveRef.current = v; setIsVoiceActive(v) }
  const [status,       setStatus]       = useState('Press the button to start.')
  const [logs,         setLogs]         = useState([])
  const [textInput,    setTextInput]    = useState('')
  const [textLoading,  setTextLoading]  = useState(false)

  // Refs (audio pipeline)
  const mediaStream        = useRef(null)
  const mediaSource        = useRef(null)
  const mediaAnalyser      = useRef(null)
  const mediaAudioContext  = useRef(null)
  const mediaProcessor     = useRef(null)
  const speechMonitorTimer = useRef(null)
  const lastSpeechAt       = useRef(0)
  const recorderStartedAt  = useRef(0)
  const pcmChunks          = useRef([])
  const sampleRateRef      = useRef(48000)
  const isCapturing        = useRef(false)
  const keepListening      = useRef(false)
  const sessionIdRef       = useRef(`session_${Date.now()}_${Math.random().toString(36).slice(2,8)}`)
  const persistedIdsRef    = useRef(new Set())
  const [dbSavedCount, setDbSavedCount] = useState(0)

  // ── DB save helper ───────────────────────────────────────────────────────────
  const persistHistoryEntries = async (entries, tokenOverride = '') => {
    const token = tokenOverride || authTokenRef.current || ''
    if (!token || !entries.length) return
    const unsaved = entries.filter(e => !persistedIdsRef.current.has(e.client_entry_id))
    if (!unsaved.length) return
    // Mark as persisted immediately to block any racing call (e.g. useEffect)
    unsaved.forEach(e => persistedIdsRef.current.add(e.client_entry_id))
    const ordered = [...unsaved].reverse()
    try {
      const r = await fetch(`${API_BASE_URL}/history/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ entries: ordered.map(e => ({
          client_entry_id: e.client_entry_id,
          session_id:      e.session_id,
          source_lang:     e.source_lang,
          target_lang:     e.target_lang,
          original_text:   e.original_text,
          translated_text: e.translated_text,
          created_at:      e.created_at || null,
        })) })
      })
      const d = await r.json()
      if (d.status === 'success') {
        console.log(`[DB] ✓ Salvat ${unsaved.length} intrare(i) în Supabase`)
        setDbSavedCount(n => n + unsaved.length)
      } else {
        // Save failed — remove from persisted set so it can be retried
        unsaved.forEach(e => persistedIdsRef.current.delete(e.client_entry_id))
        console.warn('[DB] ✗ Salvare eșuată:', d)
      }
    } catch (err) {
      unsaved.forEach(e => persistedIdsRef.current.delete(e.client_entry_id))
      console.error('[DB] ✗ Eroare rețea:', err)
    }
  }

  // ── Auth ────────────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    await supabase.auth.signOut()
    setAuthUser(null); setAuthToken('')
    persistedIdsRef.current.clear()
    setDbSavedCount(0)
    setPage('main')
  }
  const handleUserUpdate = (user) => setAuthUser(normalizeUser(user))
  const openLogin  = () => { setAuthInitMode('login');  setShowAuth(true) }
  const openSignup = () => { setAuthInitMode('signup'); setShowAuth(true) }

  // Persist an edited card — update logs state + PATCH DB
  const handleSaveEdit = (clientEntryId, updates) => {
    setLogs(prev => prev.map(e =>
      e.client_entry_id === clientEntryId ? { ...e, ...updates, edited: true } : e
    ))
    if (authTokenRef.current && clientEntryId) {
      fetch(`${API_BASE_URL}/history/${encodeURIComponent(clientEntryId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authTokenRef.current}` },
        body: JSON.stringify(updates),
      }).catch(e => console.warn('[edit] DB update failed:', e))
    }
  }

  // Re-translate edited original text (used by TranslationCard after user edits)
  const handleRetranslate = async (text) => {
    const r = await fetch(`${API_BASE_URL}/translate_text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // no_memory: true → no chat history bleed-through between independent edits
      body: JSON.stringify({ text, target_lang: targetLang, native_lang: nativeLang, country_lang: countryLang, no_memory: true }),
    })
    return await r.json()
  }

  // Supabase auth state — handles login, logout, token refresh, and password recovery
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        setShowResetPassword(true)
        return
      }
      if (session) {
        const user = normalizeUser(session.user)
        setAuthToken(session.access_token)
        setAuthUser(user)
        if (user?.main_language) localStorage.setItem('translator_main_lang', user.main_language)
        // Restore country saved during signup
        if (user?.country && user?.id) {
          localStorage.setItem(`user_country_${user.id}`, user.country)
        }
        // Apply saved translation mode preference from profile
        if (user?.preferred_mode) {
          setTranslationMode(user.preferred_mode)
          localStorage.setItem('translation_mode', user.preferred_mode)
          setMuted(!user.preferred_mode.endsWith('speech'))
        }
        // Upload anything captured while logged out
        if (event === 'SIGNED_IN') {
          await persistHistoryEntries(logs, session.access_token)
        }
      } else {
        setAuthToken('')
        setAuthUser(null)
      }
    })
    return () => subscription.unsubscribe()
  }, []) // eslint-disable-line

  // Sync header avatar from localStorage when user changes
  useEffect(() => {
    if (authUser?.id) {
      const saved = localStorage.getItem(`avatar_${authUser.id}`)
      setHeaderAvatarUrl(saved || null)
    } else {
      setHeaderAvatarUrl(null)
    }
  }, [authUser?.id])

  // Save new log entries to DB whenever they change (while logged in)
  useEffect(() => {
    if (authUser && authTokenRef.current && logs.length > 0) persistHistoryEntries(logs)
  }, [authUser, logs]) // eslint-disable-line

  useEffect(() => () => stopListening(), []) // eslint-disable-line

  // ── Audio pipeline ──────────────────────────────────────────────────────────
  const generateCEI = () =>
    window.crypto?.randomUUID?.() || `e_${Date.now()}_${Math.random().toString(36).slice(2,10)}`

  const hasHumanVoice = chunks => {
    let s=0, c=0
    for (const ch of chunks) for (const v of ch) { s += v*v; c++ }
    return c > 0 && Math.sqrt(s/c) > 0.02
  }

  const encodeWav = (chunks, sr) => {
    const n = chunks.reduce((a, c) => a + c.length, 0)
    const buf = new ArrayBuffer(44 + n*2); const view = new DataView(buf); let off = 0
    const ws = s => { for (let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); off+=s.length }
    ws('RIFF'); view.setUint32(off,36+n*2,true); off+=4; ws('WAVE'); ws('fmt ')
    view.setUint32(off,16,true);off+=4; view.setUint16(off,1,true);off+=2; view.setUint16(off,1,true);off+=2
    view.setUint32(off,sr,true);off+=4; view.setUint32(off,sr*2,true);off+=4
    view.setUint16(off,2,true);off+=2; view.setUint16(off,16,true);off+=2; ws('data')
    view.setUint32(off,n*2,true); off+=4; let so=off
    for (const c of chunks) for (const v of c) {
      const s = Math.max(-1, Math.min(1, v))
      view.setInt16(so, s < 0 ? s*0x8000 : s*0x7fff, true); so+=2
    }
    return new Blob([buf], {type:'audio/wav'})
  }

  const stopSpeechMonitor = () => {
    if (speechMonitorTimer.current) { clearInterval(speechMonitorTimer.current); speechMonitorTimer.current = null }
  }

  const startSpeechMonitor = () => {
    stopSpeechMonitor(); if (!mediaAnalyser.current) return
    const an = mediaAnalyser.current; const d = new Float32Array(an.fftSize)
    lastSpeechAt.current = Date.now(); recorderStartedAt.current = Date.now()
    speechMonitorTimer.current = setInterval(() => {
      if (!isCapturing.current) return
      an.getFloatTimeDomainData(d); let sq=0; for (const v of d) sq += v*v
      if (Math.sqrt(sq/d.length) > 0.02) {
        lastSpeechAt.current = Date.now()
        if (!isVoiceActiveRef.current) setVoiceActive(true)
      }
      const silence   = Date.now() - lastSpeechAt.current
      const recorded  = Date.now() - recorderStartedAt.current
      if (recorded > 1000 && silence >= 2000) stopCurrentCaptureAndProcess()
    }, 150)
  }

  const stopCurrentCaptureAndProcess = async () => {
    if (!isCapturing.current) return
    isCapturing.current = false; stopSpeechMonitor()
    const captured = pcmChunks.current; pcmChunks.current = []
    if (!hasHumanVoice(captured)) {
      setStatus('Nu am detectat voce. Te ascult...')
      if (keepListening.current) startRecorderCapture(); return
    }
    const blob = encodeWav(captured, sampleRateRef.current)
    if (blob.size <= 3000) {
      setStatus('Audio prea scurt. Te ascult...')
      if (keepListening.current) startRecorderCapture(); return
    }
    setStatus('Se procesează...')
    await sendToBackend(blob)
    if (keepListening.current) startRecorderCapture()
  }

  const startRecorderCapture = () => {
    if (!mediaStream.current || isCapturing.current) return
    pcmChunks.current = []; isCapturing.current = true
    setVoiceActive(false)
    setStatus('Te ascult… Vorbește acum.')
    startSpeechMonitor()
  }

  const sendToBackend = async blob => {
    if (isFinalizing) return; setIsFinalizing(true)
    // Always read token from ref — closures captured in audio pipeline callbacks
    // may be stale, but the ref is always current
    const currentToken = authTokenRef.current
    const cei = generateCEI()
    const fd = new FormData(); fd.append('audio', blob, 'audio.wav')
    try {
      setStatus('Traducere în curs...')
      const r = await fetch(
        `${API_BASE_URL}/process?target_lang=${targetLang}&client_entry_id=${encodeURIComponent(cei)}&native_lang=${encodeURIComponent(nativeLang)}&country_lang=${encodeURIComponent(countryLang)}`,
        { method:'POST', headers: currentToken ? {Authorization:`Bearer ${currentToken}`} : {}, body: fd }
      )
      const data = await r.json()
      if (data.status !== 'success') { setStatus('Eroare la procesare'); return }

      const sL = (data.source_lang || 'AUTO').toUpperCase()
      const tL = (data.target_lang || 'EN').toUpperCase()

      const entry = {
        id: Date.now() + Math.random(),
        client_entry_id: cei,
        session_id: sessionIdRef.current,
        source_lang: sL, target_lang: tL,
        original_text:   data.original_text   || '',
        translated_text: data.translated_text || '',
        audio_url: null,
        created_at: new Date().toISOString(),
      }

      setLogs(prev => [entry, ...prev])
      if (currentToken) persistHistoryEntries([entry], currentToken)

      if (data.audio_url && !mutedRef.current) {
        setStatus('Redau traducerea...')
        await playAudioUrl(data.audio_url)
      }
    } catch(e) { console.error(e); setStatus('Eroare server') }
    finally { setIsFinalizing(false); setVoiceActive(false); if (keepListening.current) setStatus('Te ascult…') }
  }


  const handleTextTranslate = async () => {
    const text = textInput.trim()
    if (!text || textLoading) return
    setTextLoading(true); setStatus('Translating…')
    try {
      const r = await fetch(`${API_BASE_URL}/translate_text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, target_lang: targetLang, native_lang: nativeLang, country_lang: countryLang, user: 'text_user' }),
      })
      const d = await r.json()
      if (d.translated_text) {
        const entry = {
          id: Date.now() + Math.random(),
          client_entry_id: generateCEI(),
          session_id: sessionIdRef.current,
          source_lang: (d.source_lang && d.source_lang !== 'auto' ? d.source_lang : 'AUTO').toUpperCase(),
          target_lang: (d.lang || targetLang || 'en').toUpperCase(),
          original_text: text,
          translated_text: d.translated_text,
          audio_url: null,
          created_at: new Date().toISOString(),
        }
        setLogs(prev => [entry, ...prev])
        if (authTokenRef.current) persistHistoryEntries([entry], authTokenRef.current)
        setTextInput('')
        // Play TTS if not muted
        if (!mutedRef.current && d.translated_text) {
          try {
            const ttsRes = await fetch(`${API_BASE_URL}/tts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: d.translated_text, lang: (d.lang || targetLang).toLowerCase() }),
            })
            const ttsData = await ttsRes.json()
            if (ttsData.audio_url) await playAudioUrl(ttsData.audio_url)
            else speakText(d.translated_text, d.lang || targetLang)
          } catch { speakText(d.translated_text, d.lang || targetLang) }
        }
      }
    } catch(e) { console.error(e) }
    finally { setTextLoading(false); setStatus('Press the button to start.') }
  }

  const toggleTranslator = async () => {
    if (mediaAudioContext.current?.state === 'suspended') await mediaAudioContext.current.resume()
    if (!isListening) {
      keepListening.current = true; setIsListening(true)
      setStatus('Active — listening...'); startListening()
    } else {
      keepListening.current = false; setIsListening(false)
      setStatus('Stopped.'); stopListening()
    }
  }

  const startListening = async () => {
    try {
      if (!mediaStream.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
        })
        mediaStream.current = stream
        mediaAudioContext.current = new (window.AudioContext || window.webkitAudioContext)()
        sampleRateRef.current = mediaAudioContext.current.sampleRate
        const source = mediaAudioContext.current.createMediaStreamSource(stream)
        mediaSource.current = source
        mediaAnalyser.current = mediaAudioContext.current.createAnalyser()
        mediaAnalyser.current.fftSize = 2048
        mediaProcessor.current = mediaAudioContext.current.createScriptProcessor(4096, 1, 1)
        mediaProcessor.current.onaudioprocess = e => {
          if (!isCapturing.current) return
          pcmChunks.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
        }
        source.connect(mediaAnalyser.current)
        source.connect(mediaProcessor.current)
        mediaProcessor.current.connect(mediaAudioContext.current.destination)
      }
      setIsListening(true); startRecorderCapture()
    } catch(err) {
      console.error(err); alert('Verifică permisiunile microfonului!')
      setIsListening(false); setStatus('Deconectat')
    }
  }

  const stopListening = () => {
    keepListening.current = false; isCapturing.current = false
    stopSpeechMonitor(); setIsListening(false)
    mediaStream.current?.getTracks().forEach(t => t.stop()); mediaStream.current = null
    if (mediaProcessor.current) {
      mediaProcessor.current.disconnect(); mediaProcessor.current.onaudioprocess = null; mediaProcessor.current = null
    }
    mediaSource.current?.disconnect(); mediaSource.current = null
    mediaAudioContext.current?.close().catch(() => {}); mediaAudioContext.current = null
    mediaAnalyser.current = null; pcmChunks.current = []; setStatus('Stopped')
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="app-root">

      {/* Header */}
      <header className="app-header">
        <div className="app-header-left">
          <div className="app-logo"><IconTranslate/></div>
          <span className="app-title">Translator Live v2</span>
        </div>
        <div className="app-header-right">
          <button className="header-icon-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === 'dark' ? <IconSun/> : <IconMoon/>}
          </button>
          <div className="avatar-wrap">
            <button className="header-icon-btn header-avatar-btn"
              onClick={() => setShowDropdown(p => !p)}
              title={authUser ? authUser.username : 'Account'}>
              {authUser
                ? (headerAvatarUrl
                    ? <img src={headerAvatarUrl} alt="avatar" style={{ width:'38px', height:'38px', borderRadius:'50%', objectFit:'cover', display:'block' }} />
                    : <span className="avatar-letter">{authUser.username?.[0]?.toUpperCase()}</span>)
                : <IconUser/>}
            </button>
            {showDropdown && (authUser ? (
              <UserDropdown authUser={authUser} avatarUrl={headerAvatarUrl}
                onProfile={() => { setPage('profile'); setShowDropdown(false) }}
                onSettings={() => { setShowSettings(true); setShowDropdown(false) }}
                onLogout={() => { handleLogout(); setShowDropdown(false) }}
                onClose={() => setShowDropdown(false)} />
            ) : (
              <GuestDropdown
                onLogin={() => { openLogin(); setShowDropdown(false) }}
                onSignup={() => { openSignup(); setShowDropdown(false) }}
                onSettings={() => { setShowSettings(true); setShowDropdown(false) }}
                onClose={() => setShowDropdown(false)} />
            ))}
          </div>
        </div>
      </header>

      {/* Profile page */}
      {page === 'profile' && (
        <div className="subpage-wrap">
          <ProfilePage authUser={authUser} authToken={authToken}
            onBack={() => setPage('main')}
            onGoHistory={() => setPage('history')}
            onUserUpdate={handleUserUpdate}
            onAvatarChange={url => setHeaderAvatarUrl(url)}
            onModeChange={changeMode} />
        </div>
      )}

      {/* History page — full height, scrollable */}
      {page === 'history' && (
        <div className="subpage-wrap subpage-wrap--hist">
          <HistoryPage authToken={authToken} muted={muted} onBack={() => setPage('profile')} onRetranslate={handleRetranslate} onSaveEdit={handleSaveEdit} />
        </div>
      )}

      {/* Main page */}
      {page === 'main' && (
        <main className="app-main">
          {isSpeechInput ? (
            <div className="listen-btn-wrap">
              <button
                className={`listen-pill ${isListening ? 'listen-pill--active' : ''}`}
                onClick={toggleTranslator}
                disabled={isFinalizing || isVoiceActive}>
                <span className={`mic-dot ${isListening ? 'mic-dot--pulse' : ''}`}/>
                {isFinalizing ? <IconTranslate/> : <IconMic/>}
                <span>{isFinalizing ? 'Translating…' : isListening ? 'Listening…' : 'Start Listening'}</span>
              </button>
            </div>
          ) : (
            <div className="text-translate-wrap">
              <textarea
                className="text-translate-input"
                placeholder="Type text to translate…"
                value={textInput}
                onChange={e => setTextInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTextTranslate() } }}
                rows={3}
              />
              <button
                className={`listen-pill ${textLoading ? 'listen-pill--active' : ''}`}
                onClick={handleTextTranslate}
                disabled={textLoading || !textInput.trim()}>
                <span className={`mic-dot ${textLoading ? 'mic-dot--pulse' : ''}`}/>
                <span>{textLoading ? 'Translating…' : 'Translate'}</span>
              </button>
            </div>
          )}

          <div className="live-card">
            <h3 className="section-title">Live Translations</h3>
            <p className="section-sub">Your speech is automatically transcribed and translated in real-time</p>
            {logs.length > 0 ? (
              <div className="logs-list">
                {logs.map(entry => (
                  <TranslationCard key={entry.id} entry={entry} muted={muted} onRetranslate={handleRetranslate} onSaveEdit={handleSaveEdit}/>
                ))}
              </div>
            ) : (
              <p className="hint-center">
                {isSpeechInput ? 'Press the button above and start speaking.' : 'Type something above and press Translate.'}
              </p>
            )}
          </div>
        </main>
      )}

      {showAuth && (
        <AuthModal initialMode={authInitMode} onClose={() => setShowAuth(false)} onModeChange={changeMode} />
      )}
      {showResetPassword && (
        <ResetPasswordModal onDone={() => { setShowResetPassword(false); setPage('main') }} />
      )}
      {showSettings && (
        <SettingsModal translationMode={translationMode} onModeChange={changeMode}
          onClose={() => setShowSettings(false)}/>
      )}
    </div>
  )
}