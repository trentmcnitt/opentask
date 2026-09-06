'use client'

import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useIsMobile } from '@/hooks/useIsMobile'
import { showToast } from '@/lib/toast'
import { trackState, periodLabel } from '@/lib/track'
import { log as logger } from '@/lib/logger'
import type { Task } from '@/types'

/**
 * What a quota actually is, behind its chip.
 *
 * Trent, 2026-09-06: "press and hold to bring up any explicit notes for it…
 * more importantly, notes, because some of these are pretty terse. It just
 * says things like 'Eggs' so it'd be nice to be able to be reminded about what
 * each item being tracked is."
 *
 * So this is an EDITOR, not a readout. Every one of his eight quotas had an
 * empty notes field when this was built, which means a display-only panel
 * would have shown him eight empty boxes — the note has to be writable here or
 * "Eggs" stays "Eggs" forever.
 *
 * A sheet on the phone and a dialog on the desktop, matching ReminderDetail:
 * a textarea under an iOS keyboard needs the bottom sheet, not a popover.
 */
export function TrackDetailSheet({
  task,
  open,
  onOpenChange,
  onSaved,
}: {
  task: Task | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Refresh the list once a note is saved, so the next open shows it. */
  onSaved?: () => void
}) {
  const isMobile = useIsMobile()
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  // The note as the server has it, so "dirty" is a comparison and not a guess.
  const savedRef = useRef('')

  useEffect(() => {
    if (!open || !task) return
    const initial = task.notes ?? ''
    setNotes(initial)
    savedRef.current = initial
  }, [open, task])

  if (!task) return null

  const state = trackState(task)
  const period = periodLabel(task.rrule)
  const dirty = notes !== savedRef.current

  async function save() {
    if (!task || !dirty) return
    setSaving(true)
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Through updateTask, so the edit is transactional and undoable like
        // any other — a note is task data, not a UI preference.
        body: JSON.stringify({ notes: notes.trim() || null }),
      })
      if (!res.ok) throw new Error(`PATCH ${res.status}`)
      savedRef.current = notes
      showToast({ message: 'Note saved', type: 'success' })
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      logger.error('ui', 'Saving a quota note failed:', err)
      showToast({ message: 'Could not save the note', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const body = (
    <div className="space-y-5 px-4 pb-4">
      {/* The progress is the sheet's subtitle already; repeating it as a field
          here said the same number twice in adjacent lines. */}
      <dl className="text-sm">
        <dt className="text-muted-foreground text-xs">Tracking since</dt>
        <dd>{formatCreated(task.created_at)}</dd>
      </dl>

      <div className="space-y-2">
        <label htmlFor="quota-notes" className="text-muted-foreground text-xs">
          Notes
        </label>
        <Textarea
          id="quota-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={5}
          placeholder="What does this one actually mean?"
          className="resize-none text-[16px]"
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )

  const description = `${state.current} of ${state.target}${period ? ` ${period}` : ''}`

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
          <div className="px-4 pt-4 pb-2">
            <SheetTitle className="text-left">{task.title}</SheetTitle>
            <SheetDescription className="text-left">{description}</SheetDescription>
          </div>
          {body}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <div className="px-4 pt-4 pb-2">
          <DialogTitle>{task.title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </div>
        {body}
      </DialogContent>
    </Dialog>
  )
}

/** "Tracking since March 2026" — the month is the useful grain for a quota. */
function formatCreated(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
