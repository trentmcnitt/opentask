'use client'

import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

/**
 * Inline notes section for QuickActionPanel.
 *
 * Create mode: shows "+ Add notes..." collapse link, expands to textarea.
 * Edit mode: shows read-only text (clamped to 3 lines) with pencil edit button,
 * or "+ Add notes..." if empty. Blue indicator when pendingNotes is set.
 */
export function NotesInlineSection({
  isCreateMode,
  currentNotes,
  pendingNotes,
  expanded,
  onExpand,
  onCollapse,
  onChange,
}: {
  isCreateMode: boolean
  currentNotes: string | null
  pendingNotes: string | null | undefined
  expanded: boolean
  onExpand: () => void
  onCollapse: () => void
  onChange: (value: string | null | undefined) => void
}) {
  const [draft, setDraft] = useState('')
  const [readExpanded, setReadExpanded] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  const [isClamped, setIsClamped] = useState(false)
  const displayNotes = pendingNotes !== undefined ? pendingNotes : currentNotes
  const isDirty = pendingNotes !== undefined

  // Detect whether the text overflows the 3-line clamp
  useEffect(() => {
    if (readExpanded) return
    const el = textRef.current
    if (el) {
      setIsClamped(el.scrollHeight > el.clientHeight)
    }
  }, [displayNotes, readExpanded])

  const handleStartEdit = () => {
    setReadExpanded(false)
    setDraft(displayNotes ?? '')
    onExpand()
  }

  const handleDone = () => {
    const trimmed = draft.trim()
    const newValue = trimmed || null
    // Only stage if different from current
    if (newValue !== currentNotes) {
      onChange(newValue)
    } else {
      onChange(undefined) // reset pending
    }
    onCollapse()
  }

  // Create mode: show link or textarea
  if (isCreateMode) {
    if (!expanded) {
      return (
        <button
          type="button"
          onClick={() => {
            setDraft('')
            onExpand()
          }}
          className="text-muted-foreground hover:text-foreground text-xs transition-colors"
        >
          + Add notes...
        </button>
      )
    }
    return (
      <div className="space-y-1">
        <Textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            // Stage notes as user types in create mode
            const trimmed = e.target.value.trim()
            onChange(trimmed || null)
          }}
          placeholder="Add notes..."
          className="min-h-[60px] text-sm"
          autoFocus
        />
      </div>
    )
  }

  // Edit mode: no notes and not expanded — show add link
  if (!displayNotes && !expanded) {
    return (
      <button
        type="button"
        onClick={handleStartEdit}
        className="text-muted-foreground hover:text-foreground text-xs transition-colors"
      >
        + Add notes...
      </button>
    )
  }

  // Edit mode: has notes but not expanded — show read-only with optional expand
  if (!expanded) {
    return (
      <div>
        <div className="flex items-start gap-2">
          {/* `break-words`: notes often hold an unbroken path or URL; without
              it that line runs past the panel's edge once "more" unclamps it. */}
          <p
            ref={textRef}
            className={cn(
              'min-w-0 flex-1 text-xs break-words whitespace-pre-wrap',
              !readExpanded && 'line-clamp-3',
              isDirty ? 'text-blue-500' : 'text-muted-foreground',
            )}
          >
            {displayNotes}
          </p>
          <button
            type="button"
            onClick={handleStartEdit}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <Pencil className="size-3" />
          </button>
        </div>
        {isClamped && (
          <button
            type="button"
            onClick={() => setReadExpanded(!readExpanded)}
            className="text-muted-foreground hover:text-foreground mt-0.5 text-xs"
          >
            {readExpanded ? 'less' : 'more'}
          </button>
        )}
      </div>
    )
  }

  // Edit mode: expanded — show textarea with Done button
  // Stage pendingNotes on every keystroke so dirty state is accurate and
  // dismissing the parent dialog mid-edit doesn't silently lose changes.
  return (
    <div className="space-y-1">
      <Textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          const trimmed = e.target.value.trim()
          const newValue = trimmed || null
          if (newValue !== currentNotes) {
            onChange(newValue)
          } else {
            onChange(undefined)
          }
        }}
        placeholder="Add notes..."
        className="min-h-[60px] text-sm"
        autoFocus
      />
      <Button size="xs" variant="outline" onClick={handleDone}>
        Done
      </Button>
    </div>
  )
}
