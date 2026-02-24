'use client'

import { useState, useCallback, useRef, useEffect } from 'react'

/**
 * Speech recognition hook using the Web Speech API.
 *
 * Environment detection: Only returns isSupported=true on platforms where
 * the API actually works. Known non-working environments:
 * - WKWebView (native iOS app): fires "service-not-allowed" error immediately
 * - Standalone PWA on iOS: API exists but silently fails (WebKit Bug 225298)
 * - Firefox: API behind a flag, not usable
 *
 * Safari workarounds built in:
 * - New SpeechRecognition instance per session (avoids first-result-only hang)
 * - Silence timeout: Safari sometimes never sets isFinal=true
 * - Safety timeout: onend doesn't always fire
 */

// Safari silence timeout — if no new results arrive within this window,
// treat the last interim result as final
const SILENCE_TIMEOUT_MS = 1000

// Safety timeout — if onend never fires, force cleanup
const SAFETY_TIMEOUT_MS = 10000

function detectSupport(): boolean {
  if (typeof window === 'undefined') return false

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return false

  // Standalone PWA on iOS — silently fails
  if ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone) return false
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(display-mode: standalone)').matches) return false
  }

  // WKWebView detection: iOS device with AppleWebKit but no "Safari" in UA
  const ua = navigator.userAgent
  if (/(iPhone|iPod|iPad).*AppleWebKit/i.test(ua) && !/Safari/i.test(ua)) return false

  // Firefox — not supported
  if (/Firefox/i.test(ua)) return false

  return true
}

export interface UseSpeechRecognitionReturn {
  isSupported: boolean
  isListening: boolean
  startListening: () => void
  stopListening: () => void
  transcript: string
  error: string | null
}

export function useSpeechRecognition(): UseSpeechRecognitionReturn {
  const [isSupported] = useState(detectSupport)
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastInterimRef = useRef('')

  const cleanup = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current)
      safetyTimerRef.current = null
    }
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null
      recognitionRef.current.onerror = null
      recognitionRef.current.onend = null
      recognitionRef.current.onstart = null
      try {
        recognitionRef.current.abort()
      } catch {
        // Ignore — may already be stopped
      }
      recognitionRef.current = null
    }
    lastInterimRef.current = ''
  }, [])

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {
        // Ignore
      }
    }
    cleanup()
    setIsListening(false)
  }, [cleanup])

  const startListening = useCallback(() => {
    if (!isSupported) return

    // Clean up any previous session
    cleanup()
    setError(null)
    setTranscript('')

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return

    // Create a fresh instance each session (Safari workaround)
    const recognition = new SR()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.lang = navigator.language || 'en-US'
    recognitionRef.current = recognition

    recognition.onstart = () => {
      setIsListening(true)

      // Safety timeout: if onend never fires, force cleanup
      safetyTimerRef.current = setTimeout(() => {
        if (lastInterimRef.current) {
          setTranscript(lastInterimRef.current)
        }
        stopListening()
      }, SAFETY_TIMEOUT_MS)
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = ''
      let interimTranscript = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          finalTranscript += result[0].transcript
        } else {
          interimTranscript += result[0].transcript
        }
      }

      if (finalTranscript) {
        setTranscript(finalTranscript)
        lastInterimRef.current = ''
        // Clear silence timer — we got a final result
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current)
          silenceTimerRef.current = null
        }
      } else if (interimTranscript) {
        lastInterimRef.current = interimTranscript
        setTranscript(interimTranscript)

        // Reset silence timer — Safari isFinal workaround
        // If no new results arrive within SILENCE_TIMEOUT_MS, treat as final
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current)
        }
        silenceTimerRef.current = setTimeout(() => {
          if (lastInterimRef.current) {
            setTranscript(lastInterimRef.current)
          }
          stopListening()
        }, SILENCE_TIMEOUT_MS)
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const errorMessages: Record<string, string> = {
        'no-speech': 'No speech detected. Try again.',
        'audio-capture': 'No microphone found.',
        'not-allowed': 'Microphone access denied.',
        'service-not-allowed': 'Speech recognition unavailable.',
        network: 'Network error. Check your connection.',
      }
      setError(errorMessages[event.error] || 'Speech recognition failed.')
      stopListening()
    }

    recognition.onend = () => {
      // If we have an interim result that never became final (Safari bug),
      // keep it as the transcript
      if (lastInterimRef.current) {
        setTranscript(lastInterimRef.current)
      }
      cleanup()
      setIsListening(false)
    }

    try {
      recognition.start()
    } catch {
      setError('Could not start speech recognition.')
      cleanup()
      setIsListening(false)
    }
  }, [isSupported, cleanup, stopListening])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  return {
    isSupported,
    isListening,
    startListening,
    stopListening,
    transcript,
    error,
  }
}
