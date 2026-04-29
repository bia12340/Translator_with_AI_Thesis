import { useEffect, useRef, useState } from 'react'
import './App.css'
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:7860';

function App() {
  const [isListening, setIsListening] = useState(false)
  const [isFinalizing, setIsFinalizing] = useState(false) // <-- ADAUGĂ ACEASTĂ LINIE
  const [status, setStatus] = useState('Status: Oprit. Apasă butonul pentru a începe.')
  const [logs, setLogs] = useState([])
  const [showHistoryPage, setShowHistoryPage] = useState(false)
  const [accountHistory, setAccountHistory] = useState([])
  const [historyFoldersOpen, setHistoryFoldersOpen] = useState({})
  const [historyLoading, setHistoryLoading] = useState(false)
  const [authMode, setAuthMode] = useState('login')
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [authUser, setAuthUser] = useState(null)
  const [authToken, setAuthToken] = useState('')
  const [authError, setAuthError] = useState('')
  const [authForm, setAuthForm] = useState({
    username: '',
    email: '',
    password: '',
    main_language: '',
  })
  const [profileMainLanguage, setProfileMainLanguage] = useState('')
  const [liveTranscript, setLiveTranscript] = useState('')
  const [liveTranslation, setLiveTranslation] = useState('')
  const [liveSourceLang, setLiveSourceLang] = useState('AUTO')
  const [liveTargetLang, setLiveTargetLang] = useState('EN')
  const [showLive, setShowLive] = useState(false)
  const [targetLang] = useState('en')

  const mediaStream = useRef(null)
  const mediaSource = useRef(null)
  const mediaAnalyser = useRef(null)
  const mediaAudioContext = useRef(null)
  const mediaProcessor = useRef(null)
  const speechMonitorTimer = useRef(null)
  const lastSpeechAt = useRef(0)
  const recorderStartedAt = useRef(0)
  const pcmChunks = useRef([])
  const sampleRateRef = useRef(48000)
  const isCapturing = useRef(false)
  const keepListening = useRef(false)
  const recognitionRef = useRef(null)
  const recognitionActive = useRef(false)
  const sessionIdRef = useRef(`session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  const persistedEntryIdsRef = useRef(new Set())

  const toggleTranslator = async () => {
    // 1. Dacă sistemul audio e "adormit" (specific browserelor), îl trezim
    if (mediaAudioContext.current && mediaAudioContext.current.state === 'suspended') {
      await mediaAudioContext.current.resume();
    }

    if (!isListening) {
      // Dacă e oprit, îl pornim
      keepListening.current = true;
      setIsListening(true);
      setStatus('Status: Activ - Te ascult...');
      startListening();
    } else {
      // Dacă e pornit, îl oprim
      keepListening.current = false;
      setIsListening(false);
      setStatus('Status: Oprit.');
      stopListening();
    }
  };

  const generateClientEntryId = () => {
    if (window.crypto?.randomUUID) {
      return window.crypto.randomUUID()
    }
    return `entry_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }

  const hasHumanVoice = (floatChunks) => {
    let sumSquares = 0
    let count = 0
    for (let i = 0; i < floatChunks.length; i += 1) {
      const chunk = floatChunks[i]
      for (let j = 0; j < chunk.length; j += 1) {
        const v = chunk[j]
        sumSquares += v * v
        count += 1
      }
    }
    if (count === 0) return false
    const rms = Math.sqrt(sumSquares / count)
    return rms > 0.01
  }

  const encodeWav = (floatChunks, sampleRate) => {
    const totalSamples = floatChunks.reduce((acc, chunk) => acc + chunk.length, 0)
    const bytesPerSample = 2
    const blockAlign = bytesPerSample
    const buffer = new ArrayBuffer(44 + totalSamples * bytesPerSample)
    const view = new DataView(buffer)

    let offset = 0
    const writeString = (str) => {
      for (let i = 0; i < str.length; i += 1) {
        view.setUint8(offset + i, str.charCodeAt(i))
      }
      offset += str.length
    }

    writeString('RIFF')
    view.setUint32(offset, 36 + totalSamples * bytesPerSample, true); offset += 4
    writeString('WAVE')
    writeString('fmt ')
    view.setUint32(offset, 16, true); offset += 4
    view.setUint16(offset, 1, true); offset += 2
    view.setUint16(offset, 1, true); offset += 2
    view.setUint32(offset, sampleRate, true); offset += 4
    view.setUint32(offset, sampleRate * blockAlign, true); offset += 4
    view.setUint16(offset, blockAlign, true); offset += 2
    view.setUint16(offset, 16, true); offset += 2
    writeString('data')
    view.setUint32(offset, totalSamples * bytesPerSample, true); offset += 4

    let sampleOffset = offset
    for (let i = 0; i < floatChunks.length; i += 1) {
      const chunk = floatChunks[i]
      for (let j = 0; j < chunk.length; j += 1) {
        const s = Math.max(-1, Math.min(1, chunk[j]))
        view.setInt16(sampleOffset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
        sampleOffset += 2
      }
    }

    return new Blob([view], { type: 'audio/wav' })
  }

  const stopRecognition = () => {
    if (recognitionRef.current && recognitionActive.current) {
      recognitionActive.current = false
      recognitionRef.current.stop()
    }
  }

  const startRecognition = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) return

    if (!recognitionRef.current) {
      const rec = new SpeechRecognition()
      rec.continuous = true
      rec.interimResults = true
      rec.lang = 'en-US'
      rec.onresult = (event) => {
        let transcript = ''
        for (let i = 0; i < event.results.length; i += 1) {
          transcript += `${event.results[i][0].transcript} `
        }
        setLiveTranscript(transcript.trim())
      }
      rec.onerror = () => {
        recognitionActive.current = false
      }
      rec.onend = () => {
        // restart only while capture is active
        if (isCapturing.current && keepListening.current) {
          try {
            rec.start()
            recognitionActive.current = true
          } catch {
            recognitionActive.current = false
          }
        }
      }
      recognitionRef.current = rec
    }

    if (!recognitionActive.current) {
      try {
        recognitionRef.current.start()
        recognitionActive.current = true
      } catch {
        recognitionActive.current = false
      }
    }
  }

  const stopSpeechMonitor = () => {
    if (speechMonitorTimer.current) {
      window.clearInterval(speechMonitorTimer.current)
      speechMonitorTimer.current = null
    }
  }

  const startSpeechMonitor = () => {
    stopSpeechMonitor()
    if (!mediaAnalyser.current) return

    const analyser = mediaAnalyser.current
    const data = new Float32Array(analyser.fftSize)
    lastSpeechAt.current = Date.now()
    recorderStartedAt.current = Date.now()

    speechMonitorTimer.current = window.setInterval(() => {
      if (!isCapturing.current) return

      analyser.getFloatTimeDomainData(data)
      let sumSquares = 0
      for (let i = 0; i < data.length; i += 1) {
        sumSquares += data[i] * data[i]
      }
      const rms = Math.sqrt(sumSquares / data.length)
      if (rms > 0.01) {
        lastSpeechAt.current = Date.now()
      }

      const silenceFor = Date.now() - lastSpeechAt.current
      const recordedFor = Date.now() - recorderStartedAt.current
      if (recordedFor > 1200 && silenceFor >= 3000) {
        stopCurrentCaptureAndProcess()
      }
    }, 150)
  }

  const stopCurrentCaptureAndProcess = async () => {
    if (!isCapturing.current) return
    isCapturing.current = false
    stopSpeechMonitor()
    stopRecognition()

    const captured = pcmChunks.current
    pcmChunks.current = []

    const hasVoice = hasHumanVoice(captured)
    if (!hasVoice) {
      setStatus('Status: Nu am detectat voce clară. Te ascult...')
      if (keepListening.current) startRecorderCapture()
      return
    }

    const audioBlob = encodeWav(captured, sampleRateRef.current)
    if (audioBlob.size <= 3000) {
      setStatus('Status: Audio prea scurt. Te ascult...')
      if (keepListening.current) startRecorderCapture()
      return
    }

    setStatus('Status: Se finalizează...')
    await sendToBackend(audioBlob)
    if (keepListening.current) {
      startRecorderCapture()
    }
  }

  const startRecorderCapture = () => {
    if (!mediaStream.current || isCapturing.current) return
    pcmChunks.current = []
    isCapturing.current = true
    setShowLive(true)
    setLiveTranscript('')
    setLiveTranslation('')
    setLiveSourceLang('AUTO')    // Resetăm la pornire
    setLiveTargetLang('...')     // Resetăm la pornire
    setStatus('Status: Te ascult... Vorbește acum.')
    startRecognition()
    startSpeechMonitor()
  }

const sendToBackend = async (blob) => {
    if (isFinalizing) return; // Prevenim trimiteri multiple
    setIsFinalizing(true); // Acum va funcționa pentru că am adăugat state-ul mai sus

    const formData = new FormData()
    formData.append('audio', blob, 'audio.wav')

    try {
      setStatus('Status: Traducere în curs...')
      const response = await fetch(`${API_BASE_URL}/process?target_lang=${targetLang}`, {
        method: 'POST',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        body: formData,
      })

      const data = await response.json()

      if (data.status !== 'success') {
        setStatus('Status: Eroare la procesare')
        return
      }

      const sLang = (data.source_lang || 'AUTO').toUpperCase()
      const tLang = (data.target_lang || 'EN').toUpperCase()

      setLiveTranscript(data.original_text || '')
      setLiveSourceLang(sLang)
      setLiveTargetLang(tLang)
      setLiveTranslation(data.translated_text || '')
      setShowLive(true)

      const entry = {
        id: Date.now() + Math.random(),
        client_entry_id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36),
        session_id: sessionIdRef.current,
        source_lang: sLang,
        target_lang: tLang,
        original_text: data.original_text || '',
        translated_text: data.translated_text || '',
        audio_url: data.audio_url || null,
      }
      
      setLogs((prev) => [entry, ...prev])
      if (authToken) persistHistoryEntries([entry], authToken)

      if (data.audio_url) {
        setStatus('Status: Redau traducerea...')
        const res = await fetch(data.audio_url)
        const ttsBlob = await res.blob()
        const url = URL.createObjectURL(ttsBlob)
        const audio = new Audio(url)

        await new Promise((resolve) => {
          audio.play().catch(console.error)
          audio.onended = () => {
            URL.revokeObjectURL(url)
            resolve()
          }
        })
      }

    } catch (e) {
      console.error('Eroare comunicare server:', e)
      setStatus('Status: Eroare server')
    } finally {
      setIsFinalizing(false) // Deblocăm procesarea
      setStatus('Status: Te ascult...')
    }
  }

  const handleAuthInput = (field, value) => {
    setAuthForm((prev) => ({ ...prev, [field]: value }))
  }

  const persistHistoryEntries = async (entries, tokenOverride = '') => {
    const token = tokenOverride || authToken || localStorage.getItem('translator_auth_token') || ''
    if (!token || !entries.length) return

    const unsaved = entries.filter((entry) => !persistedEntryIdsRef.current.has(entry.client_entry_id))
    if (!unsaved.length) return

    try {
      const response = await fetch(`${API_BASE_URL}/history/bulk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          entries: unsaved.map((entry) => ({
            client_entry_id: entry.client_entry_id,
            session_id: entry.session_id,
            source_lang: entry.source_lang,
            target_lang: entry.target_lang,
            original_text: entry.original_text,
            translated_text: entry.translated_text,
          })),
        }),
      })
      const data = await response.json()
      if (data.status === 'success') {
        unsaved.forEach((entry) => persistedEntryIdsRef.current.add(entry.client_entry_id))
      }
    } catch (err) {
      console.error('Eroare salvare istoric în cont:', err)
    }
  }

  const fetchAccountHistory = async (tokenOverride = '') => {
    const token = tokenOverride || authToken || localStorage.getItem('translator_auth_token') || ''
    if (!token) return
    setHistoryLoading(true)
    try {
      const response = await fetch(`${API_BASE_URL}/history`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json()
      if (data.status === 'success') {
        const entries = data.entries || []
        setAccountHistory(entries)
        const grouped = entries.reduce((acc, item) => {
          const key = new Date(item.created_at).toLocaleDateString('ro-RO')
          if (!acc[key]) acc[key] = 0
          acc[key] += 1
          return acc
        }, {})
        const firstKey = Object.keys(grouped)[0]
        setHistoryFoldersOpen((prev) => {
          const next = { ...prev }
          if (firstKey && typeof next[firstKey] === 'undefined') next[firstKey] = true
          return next
        })
      }
    } catch (err) {
      console.error('Eroare încărcare istoric cont:', err)
    } finally {
      setHistoryLoading(false)
    }
  }

  const openAuthModal = (mode = 'login') => {
    setAuthMode(mode)
    setAuthError('')
    setShowAuthModal(true)
  }

  const closeAuthModal = () => {
    setShowAuthModal(false)
    setAuthError('')
  }

  const handleSignup = async () => {
    setAuthError('')
    try {
      const response = await fetch(`${API_BASE_URL}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: authForm.username,
          email: authForm.email,
          password: authForm.password,
          main_language: authForm.main_language,
        }),
      })
      const data = await response.json()
      if (data.status !== 'success') {
        setAuthError(data.error || 'Signup nereușit')
        return
      }
      setAuthMode('login')
      setAuthError('Cont creat. Te poți autentifica acum.')
    } catch {
      setAuthError('Nu pot contacta serverul pentru signup')
    }
  }

  const handleLogin = async () => {
    setAuthError('')
    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: authForm.email,
          password: authForm.password,
        }),
      })
      const data = await response.json()
      if (data.status !== 'success') {
        setAuthError(data.error || 'Login nereușit')
        return
      }
      setAuthUser(data.user)
      setAuthToken(data.token)
      setProfileMainLanguage(data.user?.main_language || '')
      localStorage.setItem('translator_auth_token', data.token)
      localStorage.setItem('translator_auth_user', JSON.stringify(data.user))
      await persistHistoryEntries(logs, data.token)
      await fetchAccountHistory(data.token)
      closeAuthModal()
    } catch {
      setAuthError('Nu pot contacta serverul pentru login')
    }
  }

  const handleLogout = () => {
    setAuthUser(null)
    setAuthToken('')
    setAccountHistory([])
    setShowHistoryPage(false)
    localStorage.removeItem('translator_auth_token')
    localStorage.removeItem('translator_auth_user')
  }

  const updateMainLanguage = async () => {
    const token = authToken || localStorage.getItem('translator_auth_token') || ''
    if (!token) return
    try {
      const response = await fetch(`${API_BASE_URL}/auth/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ main_language: profileMainLanguage }),
      })
      const data = await response.json()
      if (data.status === 'success') {
        setAuthUser(data.user)
        localStorage.setItem('translator_auth_user', JSON.stringify(data.user))
      } else {
        setAuthError(data.error || 'Nu am putut salva limba principală')
      }
    } catch {
      setAuthError('Nu pot contacta serverul pentru profil')
    }
  }

  const startListening = async () => {
    try {
      if (!mediaStream.current) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      mediaStream.current = stream
      mediaAudioContext.current = new (window.AudioContext || window.webkitAudioContext)()
      sampleRateRef.current = mediaAudioContext.current.sampleRate
      const source = mediaAudioContext.current.createMediaStreamSource(stream)
      mediaSource.current = source
      mediaAnalyser.current = mediaAudioContext.current.createAnalyser()
      mediaAnalyser.current.fftSize = 2048
      mediaProcessor.current = mediaAudioContext.current.createScriptProcessor(4096, 1, 1)
      mediaProcessor.current.onaudioprocess = (event) => {
        if (!isCapturing.current) return
        const input = event.inputBuffer.getChannelData(0)
        pcmChunks.current.push(new Float32Array(input))
      }
      source.connect(mediaAnalyser.current)
      source.connect(mediaProcessor.current)
      mediaProcessor.current.connect(mediaAudioContext.current.destination)
      }
      
      setIsListening(true)
      startRecorderCapture()
    } catch (err) {
      console.error('Eroare la accesarea microfonului:', err)
      alert('Verifică permisiunile microfonului!')
      setIsListening(false)
      setStatus('Status: Deconectat')
    }
  }

  const stopListening = () => {
    keepListening.current = false
    isCapturing.current = false
    stopSpeechMonitor()
    stopRecognition()
    setIsListening(false)

    if (mediaStream.current) {
      mediaStream.current.getTracks().forEach((track) => track.stop())
      mediaStream.current = null
    }
    if (mediaProcessor.current) {
      mediaProcessor.current.disconnect()
      mediaProcessor.current.onaudioprocess = null
      mediaProcessor.current = null
    }
    if (mediaSource.current) {
      mediaSource.current.disconnect()
      mediaSource.current = null
    }
    if (mediaAudioContext.current) {
      mediaAudioContext.current.close().catch(() => {})
      mediaAudioContext.current = null
    }
    mediaAnalyser.current = null
    pcmChunks.current = []
    setStatus('Status: Oprit')
  }

  useEffect(() => {
    // Am scos pornirea automată. 
    // Acum doar curățăm resursele când închidem pagina.
    return () => {
      stopListening()
    }
  }, [])

  useEffect(() => {
    const savedToken = localStorage.getItem('translator_auth_token')
    const savedUser = localStorage.getItem('translator_auth_user')
    if (!savedToken || !savedUser) return
    try {
      setAuthToken(savedToken)
      const parsedUser = JSON.parse(savedUser)
      setAuthUser(parsedUser)
      setProfileMainLanguage(parsedUser?.main_language || '')
      fetchAccountHistory(savedToken)
    } catch {
      localStorage.removeItem('translator_auth_token')
      localStorage.removeItem('translator_auth_user')
    }
  }, [])

  useEffect(() => {
    if (authUser && authToken && logs.length > 0) {
      persistHistoryEntries(logs, authToken)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, authToken, logs])

  const historyGroupedByDay = accountHistory.reduce((acc, entry) => {
    const dayKey = new Date(entry.created_at).toLocaleDateString('ro-RO')
    if (!acc[dayKey]) acc[dayKey] = []
    acc[dayKey].push(entry)
    return acc
  }, {})

  return (
    <div className="translator-wrapper">
      <div className="card">
        <div className="card-header">
          <div className="header-left">
            {authUser && (
              <button
                className="avatar-btn"
                onClick={() => {
                  setShowHistoryPage(true)
                  fetchAccountHistory()
                }}
                title="Istoric cont"
              >
                {authUser.username?.[0]?.toUpperCase() || 'U'}
              </button>
            )}
            <h2>Translator Live v2 (React)</h2>
          </div>
          {authUser ? (
            <div className="auth-user-box">
              <span className="auth-user-name">Hi, {authUser.username}</span>
              <button className="auth-btn" onClick={handleLogout}>Logout</button>
            </div>
          ) : (
            <button className="auth-btn" onClick={() => openAuthModal('login')}>
              Login / Sign up
            </button>
          )}
        </div>
        <p id="status">{status}</p>

        {showHistoryPage ? (
          <div className="history-page">
            <div className="history-header">
              <h3>Istoric cont ({authUser?.username})</h3>
              <button className="auth-btn" onClick={() => setShowHistoryPage(false)}>Back</button>
            </div>
            <div className="profile-language-box">
              <label>Main language (optional, cod ISO ex: en, ro, es)</label>
              <div className="profile-language-row">
                <input
                  className="auth-input"
                  placeholder="en"
                  value={profileMainLanguage}
                  onChange={(e) => setProfileMainLanguage(e.target.value)}
                />
                <button className="auth-btn" onClick={updateMainLanguage}>Save</button>
              </div>
            </div>
            {historyLoading ? (
              <p className="hint">Se încarcă istoricul...</p>
            ) : accountHistory.length === 0 ? (
              <p className="hint">Nu există intrări salvate încă.</p>
            ) : (
              <div className="history-list">
                {Object.entries(historyGroupedByDay).map(([day, entries]) => (
                  <div key={day} className="history-folder">
                    <button
                      className="history-folder-header"
                      onClick={() => setHistoryFoldersOpen((prev) => ({ ...prev, [day]: !prev[day] }))}
                    >
                      <span>{day}</span>
                      <span>{historyFoldersOpen[day] ? '▼' : '▶'}</span>
                    </button>
                    {historyFoldersOpen[day] && entries.map((entry) => (
                      <div key={entry.client_entry_id} className="entry">
                        <div className="lang-tag">{entry.source_lang} ➔ {entry.target_lang}</div>
                        <div className="original"><strong>{entry.source_lang}:</strong> {entry.original_text}</div>
                        <div className="translated"><strong>{entry.target_lang}:</strong> {entry.translated_text}</div>
                        <div className="history-date">{new Date(entry.created_at).toLocaleString('ro-RO')}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : showLive && (
          <div className="live-data">
            <div className="grid grid-cols-2 gap-4">
              <div>
                {/* Am schimbat aici să folosească liveSourceLang */}
                <p className="text-sm text-sky-300">Transcript live ({liveSourceLang}):</p>
                <p className="text-slate-100">{liveTranscript || '⏳ Așteaptă să vorbești...'}</p>
              </div>
              <div>
                {/* Am schimbat aici să folosească liveTargetLang în loc de targetLang cel fix */}
                <p className="text-sm text-emerald-300">Traducere live ({liveTargetLang}):</p>
                <p className="text-emerald-200">{liveTranslation || '⏳ Se traduce...'}</p>
              </div>
            </div>
          </div>
        )}
        <div style={{ textAlign: 'center', margin: '20px 0' }}>
          <button
            onClick={toggleTranslator}
            className={isListening ? "btn-stop" : "btn-start"}
            style={{
              padding: '15px 30px',
              fontSize: '18px',
              borderRadius: '50px',
              cursor: 'pointer',
              backgroundColor: isListening ? '#ff4d4d' : '#4CAF50',
              color: 'white',
              border: 'none',
              fontWeight: 'bold',
              boxShadow: '0 4px 8px rgba(0,0,0,0.2)'
            }}
          >
            {isListening ? '🔴 Oprește Translatorul' : '🟢 Pornește Translatorul'}
          </button>
        </div>
        {!showHistoryPage && <div id="logs">
          {logs.length === 0 ? (
            <p className="hint">Se ascultă continuu. Vorbește când vrei.</p>
            
          ) : (
            logs.map((entry) => (
              <div key={entry.id} className="entry">
                <div className="lang-tag">{entry.source_lang} ➔ {entry.target_lang}</div>
                <div className="original"><strong>Original:</strong> {entry.original_text}</div>
                <div className="translated"><strong>{entry.target_lang}:</strong> {entry.translated_text}</div>
              </div>
            ))
          )}
        </div>}
      </div>

      {showAuthModal && (
        <div className="auth-modal-backdrop" onClick={closeAuthModal}>
          <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
            <div className="auth-modal-tabs">
              <button
                className={authMode === 'login' ? 'tab-btn active' : 'tab-btn'}
                onClick={() => setAuthMode('login')}
              >
                Login
              </button>
              <button
                className={authMode === 'signup' ? 'tab-btn active' : 'tab-btn'}
                onClick={() => setAuthMode('signup')}
              >
                Sign up
              </button>
            </div>

            {authMode === 'signup' && (
              <>
                <input
                  className="auth-input"
                  placeholder="Username"
                  value={authForm.username}
                  onChange={(e) => handleAuthInput('username', e.target.value)}
                />
                <input
                  className="auth-input"
                  placeholder="Main language (optional, ex: en)"
                  value={authForm.main_language}
                  onChange={(e) => handleAuthInput('main_language', e.target.value)}
                />
              </>
            )}

            <input
              className="auth-input"
              placeholder="Email"
              value={authForm.email}
              onChange={(e) => handleAuthInput('email', e.target.value)}
            />
            <input
              className="auth-input"
              type="password"
              placeholder="Password"
              value={authForm.password}
              onChange={(e) => handleAuthInput('password', e.target.value)}
            />

            {authError && <p className="auth-error">{authError}</p>}

            {authMode === 'signup' ? (
              <button className="auth-submit-btn" onClick={handleSignup}>Create account</button>
            ) : (
              <button className="auth-submit-btn" onClick={handleLogin}>Login</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default App

