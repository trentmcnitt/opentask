'use client'

import { useState, useRef, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { Plus, Mic } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition'
import { showToast } from '@/lib/toast'

interface QuickAddProps {
  onAdd: (title: string) => void | Promise<void>
  onOpenAddForm?: (title: string) => void
  /** Another surface's prompt (the Reminders page: "Add a thought…"); fixed, never rotated. */
  placeholder?: string
  ariaLabel?: string
  /** Focus the field on mount (the phone's quick-add sheet, `QuickAddSheet`). */
  autoFocus?: boolean
  /**
   * How the "open the full form" affordance is drawn. `icon` (default): the
   * `+` inside the field's left edge. `link`: an "Add manually" text link
   * under the field — the quick-add sheet, opened by the tab bar's `+` right
   * below it, where a second `+` would read as the same button.
   */
  manualAdd?: 'icon' | 'link'
  /**
   * Called after a successful submit INSTEAD of re-focusing the field for the
   * next entry. The quick-add sheet closes here; re-focusing an input inside a
   * closing sheet would hold the iOS keyboard up through the exit animation.
   */
  onSubmitted?: () => void
}

// Rotating placeholder text for the quick-add input — for the DEMO account only. The
// first-time experience gives no hint that this field understands natural language ("every
// day except Saturday", "high priority", due dates, etc.), and cycling through worked examples
// surfaces that without a tour. For a signed-in user it is just churn (Trent, 2026-09-05: "it
// feels like it's in demo mode… I don't want it cycling"), so they get the plain prompt.
// Rotation pauses as soon as the user has typed anything, and the index resets to 0 ("Add a
// task...") whenever the field goes back to empty.
const PLACEHOLDER_EXAMPLES = [
  'Add a task...',
  'Try: walk the dog every day except Saturday at 9am',
  'Try: call mom this weekend',
  'Try: pay rent on the 1st of every month',
  'Try: follow up with client tomorrow — high priority',
  'Try: dentist appointment next Tuesday at 2pm',
]
const PLACEHOLDER_ROTATE_MS = 3200

export function QuickAdd({
  onAdd,
  onOpenAddForm,
  placeholder,
  ariaLabel,
  autoFocus,
  manualAdd = 'icon',
  onSubmitted,
}: QuickAddProps) {
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [placeholderIndex, setPlaceholderIndex] = useState(0)
  const { data: session } = useSession()
  const rotate = session?.user?.is_demo === true && placeholder === undefined
  const inputRef = useRef<HTMLInputElement>(null)
  const { isSupported, isListening, startListening, stopListening, transcript, error } =
    useSpeechRecognition()
  const titleBeforeListeningRef = useRef('')

  // Rotate through example placeholders while the field is empty and idle. Pausing on non-empty
  // title avoids re-rendering while the user is actively typing (the placeholder is invisible
  // then anyway), and resetting to index 0 keeps "Add a task..." as the first thing anyone sees.
  useEffect(() => {
    if (title || !rotate) {
      setPlaceholderIndex(0)
      return
    }
    const interval = setInterval(() => {
      setPlaceholderIndex((i) => (i + 1) % PLACEHOLDER_EXAMPLES.length)
    }, PLACEHOLDER_ROTATE_MS)
    return () => clearInterval(interval)
  }, [title, rotate])

  // Surface speech recognition errors as toasts
  useEffect(() => {
    if (error) {
      showToast({ message: error, type: 'error' })
    }
  }, [error])

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
      if (onSubmitted) onSubmitted()
      else inputRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  // The typed title goes with it, so switching to the full form loses nothing.
  const openAddForm = () => {
    onOpenAddForm?.(title)
    setTitle('')
  }

  return (
    <div>
      <div
        data-tour="quick-add"
        className={cn(
          'bg-card flex items-center gap-2 rounded-lg border p-3',
          'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
          'transition-all',
        )}
      >
        {manualAdd === 'icon' && (
          <button
            type="button"
            onClick={openAddForm}
            className="hover:text-primary hover:bg-accent text-muted-foreground flex-shrink-0 rounded p-0.5 transition-colors"
            aria-label="Open full add form"
          >
            <Plus className="size-5" />
          </button>
        )}
        <Input
          ref={inputRef}
          autoFocus={autoFocus}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder={placeholder ?? PLACEHOLDER_EXAMPLES[placeholderIndex]}
          className="h-auto flex-1 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          aria-label={ariaLabel ?? 'Quick add task'}
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
              'flex-shrink-0 rounded p-0.5 transition-colors active:scale-90',
              isListening
                ? 'text-red-500 hover:text-red-600'
                : 'text-muted-foreground hover:text-primary hover:bg-accent active:bg-accent',
            )}
            aria-label={isListening ? 'Stop dictation' : 'Start dictation'}
          >
            <Mic className={cn('size-5', isListening && 'animate-pulse')} />
          </button>
        )}
      </div>
      {manualAdd === 'link' && (
        <button
          type="button"
          onClick={openAddForm}
          className="text-muted-foreground hover:text-foreground mt-2 cursor-pointer px-1 py-1 text-sm underline-offset-2 hover:underline"
        >
          Add manually
        </button>
      )}
    </div>
  )
}
