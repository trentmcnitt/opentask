'use client'

import { useState, useRef, useEffect } from 'react'
import { Plus, Mic } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition'

interface QuickAddProps {
  onAdd: (title: string) => void | Promise<void>
  onOpenAddForm?: (title: string) => void
}

export function QuickAdd({ onAdd, onOpenAddForm }: QuickAddProps) {
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { isSupported, isListening, startListening, stopListening, transcript } =
    useSpeechRecognition()
  const titleBeforeListeningRef = useRef('')

  // While listening, show live preview of base title + transcript.
  // The base title is snapshotted in the mic button click handler.
  useEffect(() => {
    if (!isListening || !transcript) return
    const base = titleBeforeListeningRef.current
    const separator = base && !base.endsWith(' ') ? ' ' : ''
    setTitle(base + separator + transcript)
  }, [isListening, transcript])

  // When listening stops, focus the input for further editing
  const prevListeningRef = useRef(false)
  useEffect(() => {
    if (!isListening && prevListeningRef.current) {
      inputRef.current?.focus()
    }
    prevListeningRef.current = isListening
  }, [isListening])

  const handleSubmit = async () => {
    const trimmed = title.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    try {
      await onAdd(trimmed)
      setTitle('')
      inputRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <div
        className={cn(
          'bg-card flex items-center gap-2 rounded-lg border p-3',
          'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
          'transition-all',
        )}
      >
        <button
          type="button"
          onClick={() => {
            onOpenAddForm?.(title)
            setTitle('')
          }}
          className="hover:text-primary hover:bg-accent text-muted-foreground flex-shrink-0 rounded p-0.5 transition-colors"
          aria-label="Open full add form"
        >
          <Plus className="size-5" />
        </button>
        <Input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder="Add a task..."
          className="h-auto flex-1 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          aria-label="Quick add task"
          disabled={submitting}
        />
        {isSupported && (
          <button
            type="button"
            onClick={() => {
              if (isListening) {
                stopListening()
              } else {
                titleBeforeListeningRef.current = title
                startListening()
              }
            }}
            className={cn(
              'flex-shrink-0 rounded p-0.5 transition-colors',
              isListening
                ? 'text-red-500 hover:text-red-600'
                : 'text-muted-foreground hover:text-primary hover:bg-accent',
            )}
            aria-label={isListening ? 'Stop dictation' : 'Start dictation'}
          >
            <Mic className={cn('size-5', isListening && 'animate-pulse')} />
          </button>
        )}
      </div>
    </div>
  )
}
