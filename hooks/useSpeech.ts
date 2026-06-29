'use client'

import { useRef, useState, useCallback, useEffect } from 'react'

export type WaveMode = 'idle' | 'listening' | 'speaking'

interface UseSpeechOptions {
  lang?: string
  silenceTimeout?: number
  voiceKey?: 'ana' | 'carlos'
  onTranscriptReady?: (text: string) => void
}

export interface UseSpeechReturn {
  startListening: () => Promise<void>
  stopListening: () => void
  speak: (text: string) => Promise<void>
  cancelSpeech: () => void
  waveMode: WaveMode
  transcript: string
  isListening: boolean
  isSpeaking: boolean
  amplitude: number
  isSupported: boolean
}

export function useSpeech({
  lang = 'pt-BR',
  silenceTimeout = 1500,
  voiceKey = 'ana',
  onTranscriptReady,
}: UseSpeechOptions = {}): UseSpeechReturn {
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [waveMode, setWaveMode] = useState<WaveMode>('idle')
  const [transcript, setTranscript] = useState('')
  const [amplitude, setAmplitude] = useState(0)

  const isListeningRef = useRef(false)
  const isSpeakingRef = useRef(false)
  const onTranscriptReadyRef = useRef(onTranscriptReady)
  onTranscriptReadyRef.current = onTranscriptReady

  const recognitionRef = useRef<any>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const accumulatedRef = useRef('')

  // Keep voiceKey stable in async callbacks
  const voiceKeyRef = useRef(voiceKey)
  voiceKeyRef.current = voiceKey

  // Generation counter — incrementing cancels any in-flight speak() loop
  const speakGenerationRef = useRef(0)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)

  // AudioContext for mic amplitude visualisation
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)

  const isSupported =
    typeof window !== 'undefined' &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

  // ── Stop TTS audio (cancels in-flight speak loop via generation) ──────────

  const stopCurrentAudio = useCallback(() => {
    speakGenerationRef.current++
    if (currentAudioRef.current) {
      currentAudioRef.current.pause()
      currentAudioRef.current = null
    }
    isSpeakingRef.current = false
  }, [])

  // ── Mic amplitude ─────────────────────────────────────────────────────────

  const stopAudio = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    analyserRef.current = null
    setAmplitude(0)
  }, [])

  const startAudio = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      streamRef.current = stream
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      audioCtxRef.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.8
      analyserRef.current = analyser
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      let lastUpdate = 0
      const tick = () => {
        const now = performance.now()
        if (now - lastUpdate >= 66) {
          analyser.getByteFrequencyData(data)
          const avg = data.reduce((s, v) => s + v, 0) / data.length
          setAmplitude(Math.min(1, avg / 70))
          lastUpdate = now
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch {
      // Mic permission denied — amplitude stays 0
    }
  }, [])

  // ── Recognition factory ───────────────────────────────────────────────────

  const createRecognition = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return null

    const rec = new SR()
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onresult = (e: any) => {
      let finalText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' '
      }

      if (!finalText.trim()) return // ignore interim-only events — prevents ambient noise from resetting timer

      accumulatedRef.current += finalText
      setTranscript(accumulatedRef.current.trim())

      // Reset timer only after confirmed speech (final result)
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = setTimeout(() => {
        const text = accumulatedRef.current.trim()
        if (text) {
          onTranscriptReadyRef.current?.(text)
          accumulatedRef.current = ''
          setTranscript('')
        }
      }, silenceTimeout)
    }

    // Auto-restart ONLY if we're actively listening AND not currently speaking
    rec.onend = () => {
      if (isListeningRef.current && !isSpeakingRef.current) {
        try { rec.start() } catch (_) {}
      }
    }

    rec.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'audio-capture') {
        isListeningRef.current = false
        setIsListening(false)
        setWaveMode('idle')
        stopAudio()
      }
    }

    return rec
  }, [lang, silenceTimeout, stopAudio])

  // Stable ref so speak/cancelSpeech can access createRecognition without dep issues
  const createRecognitionRef = useRef(createRecognition)
  createRecognitionRef.current = createRecognition

  // ── Public API ────────────────────────────────────────────────────────────

  const startListening = useCallback(async () => {
    if (!isSupported) {
      console.warn('[useSpeech] SpeechRecognition not supported. Use Chrome or Edge.')
      return
    }

    stopCurrentAudio()
    setIsSpeaking(false)

    // Stop any stale recognition before creating a fresh one
    if (recognitionRef.current) {
      recognitionRef.current.onend = null
      try { recognitionRef.current.stop() } catch (_) {}
      recognitionRef.current = null
    }

    accumulatedRef.current = ''
    setTranscript('')
    isListeningRef.current = true
    setIsListening(true)
    setWaveMode('listening')

    startAudio()

    const rec = createRecognition()
    if (!rec) return
    recognitionRef.current = rec
    try { rec.start() } catch (_) {}
  }, [isSupported, startAudio, createRecognition, stopCurrentAudio])

  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null }

    isListeningRef.current = false

    if (recognitionRef.current) {
      recognitionRef.current.onend = null
      try { recognitionRef.current.stop() } catch (_) {}
      recognitionRef.current = null
    }

    stopAudio()
    setIsListening(false)
    setWaveMode('idle')
    setTranscript('')
    accumulatedRef.current = ''
  }, [stopAudio])

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return

    stopCurrentAudio()
    const myGeneration = speakGenerationRef.current

    // ── Stop recognition while AI speaks (prevents echo from mic picking up speakers) ──
    if (recognitionRef.current) {
      recognitionRef.current.onend = null
      try { recognitionRef.current.stop() } catch (_) {}
      recognitionRef.current = null
    }

    isSpeakingRef.current = true

    const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text]

    // Fetch a single sentence; returns blob URL or null on error
    const fetchSentence = (sentence: string): Promise<string | null> => {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 12000)
      return fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sentence.trim(), voiceKey: voiceKeyRef.current }),
        signal: controller.signal,
      })
        .finally(() => clearTimeout(timeoutId))
        .then((res) => {
          if (!res.ok) throw new Error(`TTS ${res.status}`)
          return res.blob()
        })
        .then((blob) => URL.createObjectURL(blob))
        .catch((e) => { console.error('[TTS] erro pre-fetch:', e); return null })
    }

    // 1-ahead pipeline: fetch sentence N+1 while sentence N is playing
    // Never more than 2 concurrent requests → respects ElevenLabs free-plan rate limit
    let nextFetch: Promise<string | null> | null = sentences.length > 0 ? fetchSentence(sentences[0]) : null
    let firstAudio = true

    for (let i = 0; i < sentences.length; i++) {
      if (speakGenerationRef.current !== myGeneration) { nextFetch = null; break }

      const currentFetch = nextFetch ?? fetchSentence(sentences[i])

      // Kick off the NEXT fetch immediately so it runs while we await & play current
      nextFetch = i + 1 < sentences.length ? fetchSentence(sentences[i + 1]) : null

      const url = await currentFetch
      if (!url) break
      if (speakGenerationRef.current !== myGeneration) { URL.revokeObjectURL(url); break }

      if (firstAudio) {
        setIsSpeaking(true)
        setWaveMode('speaking')
        firstAudio = false
      }

      const audio = new Audio(url)
      currentAudioRef.current = audio

      await new Promise<void>((resolve) => {
        audio.onended = () => resolve()
        audio.onerror = (e) => { console.error('[TTS] audio.onerror', e); resolve() }
        audio.play().catch((e) => { console.error('[TTS] autoplay bloqueado', e); resolve() })
      })

      URL.revokeObjectURL(url)
      if (currentAudioRef.current === audio) currentAudioRef.current = null
    }

    // Revoke the pending pre-fetch if we broke early
    if (nextFetch) nextFetch.then((url) => { if (url) URL.revokeObjectURL(url) }).catch(() => {})

    if (speakGenerationRef.current === myGeneration) {
      isSpeakingRef.current = false
      setIsSpeaking(false)
      setWaveMode(isListeningRef.current ? 'listening' : 'idle')

      // ── Resume recognition now that AI finished speaking ──
      if (isListeningRef.current) {
        const rec = createRecognitionRef.current()
        if (rec) {
          recognitionRef.current = rec
          try { rec.start() } catch (_) {}
        }
      }
    }
  }, [stopCurrentAudio])

  const cancelSpeech = useCallback(() => {
    stopCurrentAudio()
    setIsSpeaking(false)
    setWaveMode(isListeningRef.current ? 'listening' : 'idle')

    // Resume recognition if it was paused for TTS
    if (isListeningRef.current && !recognitionRef.current) {
      const rec = createRecognitionRef.current()
      if (rec) {
        recognitionRef.current = rec
        try { rec.start() } catch (_) {}
      }
    }
  }, [stopCurrentAudio])

  useEffect(() => {
    return () => {
      stopListening()
      stopCurrentAudio()
    }
  }, [stopListening, stopCurrentAudio])

  return { startListening, stopListening, speak, cancelSpeech, waveMode, transcript, isListening, isSpeaking, amplitude, isSupported }
}
