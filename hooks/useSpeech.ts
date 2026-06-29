'use client'

import { useRef, useState, useCallback, useEffect } from 'react'

export type WaveMode = 'idle' | 'listening' | 'speaking'

interface UseSpeechOptions {
  lang?: string
  silenceTimeout?: number
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
  onTranscriptReady,
}: UseSpeechOptions = {}): UseSpeechReturn {
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [waveMode, setWaveMode] = useState<WaveMode>('idle')
  const [transcript, setTranscript] = useState('')
  const [amplitude, setAmplitude] = useState(0)

  // Stable refs — used inside event callbacks to avoid stale closures
  const isListeningRef = useRef(false)
  const isSpeakingRef = useRef(false)
  const onTranscriptReadyRef = useRef(onTranscriptReady)
  onTranscriptReadyRef.current = onTranscriptReady

  // Speech recognition
  const recognitionRef = useRef<any>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const accumulatedRef = useRef('')

  // ElevenLabs TTS — generation counter handles cancellation cleanly
  const speakGenerationRef = useRef(0)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)

  // AudioContext for real mic amplitude
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)

  const isSupported =
    typeof window !== 'undefined' &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

  // ── Internal cancel helper (used in multiple places) ─────────────────────

  const stopCurrentAudio = useCallback(() => {
    speakGenerationRef.current++
    if (currentAudioRef.current) {
      currentAudioRef.current.pause()
      currentAudioRef.current = null
    }
    isSpeakingRef.current = false
  }, [])

  // ── Audio amplitude analysis ──────────────────────────────────────────────

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
        if (now - lastUpdate >= 66) { // ~15 fps — avoids re-render storm
          analyser.getByteFrequencyData(data)
          const avg = data.reduce((s, v) => s + v, 0) / data.length
          setAmplitude(Math.min(1, avg / 70))
          lastUpdate = now
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch {
      // Mic permission denied — amplitude stays 0, voice still works
    }
  }, [])

  // ── SpeechRecognition ─────────────────────────────────────────────────────

  const createRecognition = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return null

    const rec = new SR()
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onresult = (e: any) => {
      // Interrupt ElevenLabs speech as soon as user starts talking
      if (isSpeakingRef.current) {
        stopCurrentAudio()
        setIsSpeaking(false)
        setWaveMode('listening')
      }

      let finalText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' '
      }

      if (finalText.trim()) {
        accumulatedRef.current += finalText
        setTranscript(accumulatedRef.current.trim())
      }

      // Reset silence timer on every result
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

    // Auto-restart to keep recognition alive (Chrome stops after ~60s or silence)
    rec.onend = () => {
      if (isListeningRef.current) {
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
      // 'no-speech' and 'network' are recoverable via onend restart
    }

    return rec
  }, [lang, silenceTimeout, stopAudio, stopCurrentAudio])

  // ── Public API ────────────────────────────────────────────────────────────

  const startListening = useCallback(async () => {
    if (!isSupported) {
      console.warn('[useSpeech] SpeechRecognition not supported. Use Chrome or Edge.')
      return
    }

    // Cancel any ongoing ElevenLabs speech
    stopCurrentAudio()
    setIsSpeaking(false)

    accumulatedRef.current = ''
    setTranscript('')
    isListeningRef.current = true
    setIsListening(true)
    setWaveMode('listening')

    startAudio() // non-blocking — amplitude is optional

    const rec = createRecognition()
    if (!rec) return
    recognitionRef.current = rec
    try { rec.start() } catch (_) {}
  }, [isSupported, startAudio, createRecognition, stopCurrentAudio])

  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null }

    isListeningRef.current = false

    if (recognitionRef.current) {
      recognitionRef.current.onend = null // prevent auto-restart
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

    // Cancel any ongoing speech (increment generation to abort prior loop)
    stopCurrentAudio()
    const myGeneration = speakGenerationRef.current

    isSpeakingRef.current = true
    setIsSpeaking(true)
    setWaveMode('speaking')

    // Split into sentences for lower perceived latency
    const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text]

    for (const sentence of sentences) {
      if (speakGenerationRef.current !== myGeneration) break

      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sentence.trim() }),
        })

        if (!res.ok || speakGenerationRef.current !== myGeneration) break

        const blob = await res.blob()
        if (speakGenerationRef.current !== myGeneration) break

        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        currentAudioRef.current = audio

        await new Promise<void>((resolve) => {
          audio.onended = () => resolve()
          audio.onerror = () => resolve()
          audio.play().catch(() => resolve())
        })

        URL.revokeObjectURL(url)
        if (currentAudioRef.current === audio) currentAudioRef.current = null
      } catch {
        break
      }
    }

    // Only restore state when we're still the current generation
    if (speakGenerationRef.current === myGeneration) {
      isSpeakingRef.current = false
      setIsSpeaking(false)
      setWaveMode(isListeningRef.current ? 'listening' : 'idle')
    }
  }, [stopCurrentAudio])

  const cancelSpeech = useCallback(() => {
    stopCurrentAudio()
    setIsSpeaking(false)
    setWaveMode(isListeningRef.current ? 'listening' : 'idle')
  }, [stopCurrentAudio])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopListening()
      stopCurrentAudio()
    }
  }, [stopListening, stopCurrentAudio])

  return { startListening, stopListening, speak, cancelSpeech, waveMode, transcript, isListening, isSpeaking, amplitude, isSupported }
}
