'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * How a bubble's title or note is saved: a PATCH with the surface's own Undo
 * toast. A promise that rejects puts the old text back.
 */
export type PeekTextSave = (value: string) => Promise<unknown> | void

/**
 * A HOLD BUBBLE'S TITLE OR NOTE, EDITABLE IN PLACE (2026-11-22, Trent via the
 * design session: the reminder and quota bubbles' title and note editable
 * "as the task selection bubble is", #497's `BarTitle`). The same rules:
 *
 * - With `onSave` the text is a button; a click turns it into a field holding
 *   ALL of it, as tall as it needs (nothing is cut while editing).
 * - Enter or leaving the field saves; Escape puts it back. A note takes a new
 *   line with Shift+Enter; a title is one line (pasted line breaks become
 *   spaces).
 * - Unchanged saves nothing. An empty title saves nothing; an empty note
 *   clears it (the caller sends `notes: null`).
 * - The new text shows at once and stays until the surface's own copy arrives
 *   (`value` changes) or the save fails.
 * - The bubble closing with the field open (a press outside it) saves, as
 *   leaving the field does: an outside press unmounts the bubble without a
 *   blur.
 *
 * The bubble must not close on the Escape that reverts a field: its
 * `PopoverContent` passes `keepOpenWhileTyping` as `onEscapeKeyDown`.
 */
export function PeekText({
  kind,
  value,
  onSave,
  className,
  emptyText,
}: {
  kind: 'title' | 'note'
  /** The current text; '' for no note. */
  value: string
  onSave?: PeekTextSave
  /** The text's style, read and editing alike. */
  className: string
  /** A note's line when there is none. */
  emptyText?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saved, setSaved] = useState<{ from: string; to: string } | null>(null)
  if (saved && saved.from !== value) setSaved(null)
  const shown = saved ? saved.to : value
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // The field closed by Enter or Escape: focus goes back to the text's button
  // (it would fall to <body>, and Radix then misses the next outside press).
  const refocus = useRef(false)
  // Escape, or a save already made: what follows (the blur) does nothing.
  const settled = useRef(true)
  const finishRef = useRef<(save: boolean) => void>(() => {})

  const finish = (save: boolean, keyed = false) => {
    if (settled.current) return
    settled.current = true
    refocus.current = keyed
    setEditing(false)
    const next =
      kind === 'title' ? draft.replace(/\s*[\r\n]+\s*/g, ' ').trim() : draft.replace(/\s+$/, '')
    if (!save || next === shown.trim() || (kind === 'title' && next === '')) return
    setSaved({ from: value, to: next })
    Promise.resolve(onSave?.(next)).catch(() => setSaved(null))
  }
  useEffect(() => {
    finishRef.current = finish
  })

  // The field as tall as its text, from one line up.
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (!editing || !field) return
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
  }, [editing, draft])
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    buttonRef.current?.focus()
  }, [editing])
  useEffect(() => {
    if (!editing) return
    const field = fieldRef.current
    field?.focus()
    field?.setSelectionRange(field.value.length, field.value.length)
    // The bubble closed with the field open: save what was typed.
    return () => finishRef.current(true)
  }, [editing])

  const start = () => {
    setDraft(shown)
    settled.current = false
    setEditing(true)
  }

  if (editing) {
    return (
      <textarea
        ref={fieldRef}
        data-peek-edit-field={kind}
        aria-label={kind === 'title' ? 'Title' : 'Note'}
        rows={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          // The page's own keys (Escape, letters acting on a selection) stay
          // out of a field being typed in.
          e.stopPropagation()
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && !(kind === 'note' && e.shiftKey)) {
            e.preventDefault()
            finish(true, true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finish(false, true)
          }
        }}
        className={cn(
          className,
          '-mx-1 block w-full resize-none overflow-hidden rounded border-0 bg-transparent px-1 outline-none',
          'ring-ring/50 ring-2',
        )}
      />
    )
  }

  const empty = shown.trim() === ''
  const words = empty ? (
    <span className="text-muted-foreground text-xs italic">{emptyText}</span>
  ) : (
    shown
  )
  if (!onSave) {
    return <p className={empty ? undefined : className}>{words}</p>
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      data-peek-edit={kind}
      title={kind === 'title' ? 'Edit title' : empty ? 'Add a note' : 'Edit note'}
      onClick={start}
      className={cn(
        !empty && className,
        'hover:bg-muted focus-visible:bg-muted -mx-1 block w-[calc(100%+0.5rem)] cursor-text rounded px-1 text-left focus-visible:outline-none',
      )}
    >
      {words}
    </button>
  )
}

/**
 * A bubble's `onEscapeKeyDown`: an Escape in a field reverts the field and
 * leaves the bubble open (Radix listens on the document, before the field).
 */
export function keepOpenWhileTyping(e: KeyboardEvent) {
  if ((document.activeElement as Element | null)?.closest('[data-peek-edit-field]')) {
    e.preventDefault()
  }
}

/** What a bubble's edit sends: its title, or its note (null clears it). */
export type PeekTextChanges = { title: string } | { notes: string | null }

/** A bubble field's save, as the bubble's caller writes it. */
export type PeekTextEdit = (changes: PeekTextChanges) => Promise<unknown> | void

/** The Undo toast's words for an edit: "Renamed: “…”", "Note saved", "Note removed". */
export function peekTextMessage(changes: PeekTextChanges): string {
  if ('title' in changes) return `Renamed: “${changes.title}”`
  return changes.notes === null ? 'Note removed' : 'Note saved'
}

/** The bubble's title and note, each editable when `onEdit` is given. */
export function PeekTitleAndNote({
  title,
  notes,
  onEdit,
  emptyNote,
  meta,
}: {
  title: string
  notes: string | null | undefined
  onEdit?: PeekTextEdit
  /** What the note line says when there is none. */
  emptyNote: { editable: string; readOnly: string }
  /** The muted line(s) under the title. */
  meta: React.ReactNode
}) {
  return (
    <>
      <div>
        <PeekText
          kind="title"
          value={title}
          onSave={onEdit && ((next) => onEdit({ title: next }))}
          className="text-sm leading-snug font-medium"
        />
        {meta}
      </div>

      <div className="border-t pt-2">
        <PeekText
          kind="note"
          value={notes ?? ''}
          onSave={onEdit && ((next) => onEdit({ notes: next === '' ? null : next }))}
          className="text-[13px] leading-relaxed whitespace-pre-wrap"
          emptyText={onEdit ? emptyNote.editable : emptyNote.readOnly}
        />
      </div>
    </>
  )
}
