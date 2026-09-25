'use client'

/**
 * Settings → Reminder periods (2026-09-24)
 *
 * Edit the user's time slots: rename one, change when it starts, add one,
 * remove one. Copies the Labels section's shape (`LabelEditor` in
 * settings/page.tsx): one row per item with an X at the end, and an add row of
 * the same shape underneath. The start time is the same native
 * `<input type="time">` the Snooze section uses for wake/sleep time.
 *
 * DELIBERATE DIFFERENCES FROM THE SIBLINGS, and why:
 * - Edits commit on blur or Enter, not on every change (the wake/sleep inputs
 *   save on change). Changing a period's start MOVES its reminders and writes
 *   an undo entry; a time input emits a change for each segment typed, so
 *   09:00 → 10:30 would otherwise move every reminder to 10:00 and then again
 *   to 10:30. Escape puts the saved value back.
 * - Removing has no confirmation dialog (Projects has one). Removal is
 *   undoable — the server restores the period AND the reminders it moved in
 *   one undo — so the toast's Undo replaces the dialog, per Trent's "undo over
 *   confirm".
 * - The X is absent on the last remaining period rather than disabled: the
 *   server refuses to remove it, and chrome for an action that cannot happen
 *   is noise.
 *
 * Rows are always listed by start time — that is the order everything else
 * uses (there is no separate ordering to edit). A row re-sorts once its new
 * start is saved, never while it is being typed.
 */

import { useCallback, useRef, useState } from 'react'
import { useTimeSlots } from '@/hooks/useTimeSlots'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { showToast } from '@/lib/toast'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { formatMinutes } from '@/lib/reminder-rule'

/** Same styling as the Snooze section's wake/sleep time inputs. */
const TIME_INPUT_CLASS =
  'rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900'

interface SlotChange {
  slot: TimeSlot
  reminders_moved: number
  undo_id: number | null
}

function byStart(slots: TimeSlot[]): TimeSlot[] {
  return [...slots].sort((a, b) => (parseHHMM(a.start_time) ?? 0) - (parseHHMM(b.start_time) ?? 0))
}

function formatStart(startTime: string): string {
  const minutes = parseHHMM(startTime)
  return minutes === null ? startTime : formatMinutes(minutes)
}

function remindersMoved(n: number): string {
  return n === 0 ? '' : ` · moved ${n} reminder${n === 1 ? '' : 's'}`
}

/** fetch + unwrap `{ data }`, throwing the server's own message on failure. */
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null
  if (!res.ok) throw new Error(body?.error || 'Something went wrong')
  return body?.data as T
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Save failed'
}

export function TimeSlotSettings() {
  // The same hook every other slot consumer reads through; each change
  // re-reads it, so the list is always what the server stored.
  const { timeSlots, loading, refresh } = useTimeSlots()
  const slots = byStart(timeSlots)
  const load = refresh

  // Undo exactly this change: `through_id` pins the entry, so it can never
  // undo an unrelated action instead. The server restores the period with
  // its reminders; re-read the list to show it.
  const undo = useCallback(
    async (undoId: number) => {
      try {
        await call('/api/undo/batch', jsonInit('POST', { through_id: undoId }))
        await load()
        showToast({ message: 'Undone', type: 'success' })
      } catch (err) {
        showToast({ message: errorMessage(err), type: 'error' })
      }
    },
    [load],
  )

  const toastWithUndo = useCallback(
    (message: string, undoId: number | null) => {
      showToast({
        message,
        type: 'success',
        action: undoId === null ? undefined : { label: 'Undo', onClick: () => void undo(undoId) },
      })
    },
    [undo],
  )

  const update = useCallback(
    async (slot: TimeSlot, changes: { label?: string; start_time?: string }) => {
      try {
        const result = await call<SlotChange>(
          `/api/time-slots/${slot.id}`,
          jsonInit('PATCH', changes),
        )
        await load()
        if (changes.start_time !== undefined) {
          toastWithUndo(
            `${result.slot.label} now starts at ${formatStart(result.slot.start_time)}` +
              remindersMoved(result.reminders_moved),
            result.undo_id,
          )
        } else {
          showToast({ message: `Renamed to "${result.slot.label}"`, type: 'success' })
        }
        return true
      } catch (err) {
        showToast({ message: errorMessage(err), type: 'error' })
        return false
      }
    },
    [load, toastWithUndo],
  )

  const remove = useCallback(
    async (slot: TimeSlot) => {
      try {
        const result = await call<SlotChange>(`/api/time-slots/${slot.id}`, { method: 'DELETE' })
        await load()
        toastWithUndo(
          `Removed "${slot.label}"` + remindersMoved(result.reminders_moved),
          result.undo_id,
        )
      } catch (err) {
        showToast({ message: errorMessage(err), type: 'error' })
      }
    },
    [load, toastWithUndo],
  )

  const add = useCallback(
    async (label: string, startTime: string) => {
      try {
        const slot = await call<TimeSlot>(
          '/api/time-slots',
          jsonInit('POST', { label, start_time: startTime }),
        )
        await load()
        showToast({ message: `Added "${slot.label}"`, type: 'success' })
        return true
      } catch (err) {
        showToast({ message: errorMessage(err), type: 'error' })
        return false
      }
    },
    [load],
  )

  // Nothing to show until the first read lands — no empty chrome.
  if (loading) return null

  return (
    <div className="space-y-2" data-testid="reminder-periods">
      {slots.map((slot) => (
        // Keyed by the SAVED values too, so a save, an undo, or a server
        // re-read resets the row's drafts to what is stored.
        <SlotRow
          key={`${slot.id}:${slot.label}:${slot.start_time}`}
          slot={slot}
          canRemove={slots.length > 1}
          onUpdate={(changes) => update(slot, changes)}
          onRemove={() => void remove(slot)}
        />
      ))}
      <AddSlotRow onAdd={add} />
    </div>
  )
}

function SlotRow({
  slot,
  canRemove,
  onUpdate,
  onRemove,
}: {
  slot: TimeSlot
  canRemove: boolean
  onUpdate: (changes: { label?: string; start_time?: string }) => Promise<boolean>
  onRemove: () => void
}) {
  const [label, setLabel] = useState(slot.label)
  const [time, setTime] = useState(slot.start_time)
  // Escape resets the draft and blurs; the blur handler still sees the old
  // draft in its closure, so this tells it not to commit.
  const cancelled = useRef(false)

  const commitLabel = async () => {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const trimmed = label.trim()
    if (!trimmed || trimmed === slot.label) {
      setLabel(slot.label)
      return
    }
    if (!(await onUpdate({ label: trimmed }))) setLabel(slot.label)
  }

  const commitTime = async () => {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    if (!time || time === slot.start_time) {
      setTime(slot.start_time)
      return
    }
    if (!(await onUpdate({ start_time: time }))) setTime(slot.start_time)
  }

  // Enter commits (by blurring, so blur stays the one commit path);
  // Escape puts the saved value back first.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, reset: () => void) => {
    if (e.key === 'Escape') {
      cancelled.current = true
      reset()
    }
    if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
  }

  return (
    <div className="flex items-center gap-2" data-slot-row={slot.id}>
      <Input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => void commitLabel()}
        onKeyDown={(e) => onKeyDown(e, () => setLabel(slot.label))}
        maxLength={100}
        aria-label={`Name of ${slot.label}`}
        className="h-8 min-w-0 flex-1 text-sm"
      />
      <input
        type="time"
        value={time}
        onChange={(e) => setTime(e.target.value)}
        onBlur={() => void commitTime()}
        onKeyDown={(e) => onKeyDown(e, () => setTime(slot.start_time))}
        aria-label={`Start time of ${slot.label}`}
        className={TIME_INPUT_CLASS}
      />
      {canRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="text-zinc-400 transition-colors hover:text-red-500"
          aria-label={`Remove ${slot.label}`}
        >
          <X className="size-4" />
        </button>
      ) : (
        <span className="w-4" aria-hidden />
      )}
    </div>
  )
}

function AddSlotRow({ onAdd }: { onAdd: (label: string, startTime: string) => Promise<boolean> }) {
  const [label, setLabel] = useState('')
  const [time, setTime] = useState('')
  const [saving, setSaving] = useState(false)
  const ready = label.trim() !== '' && time !== '' && !saving

  const submit = async () => {
    if (!ready) return
    setSaving(true)
    const added = await onAdd(label.trim(), time)
    setSaving(false)
    if (added) {
      setLabel('')
      setTime('')
    }
  }

  return (
    <div className="flex items-center gap-2 pt-1">
      <Input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
        placeholder="New period"
        maxLength={100}
        aria-label="New period name"
        className="h-8 min-w-0 flex-1 text-sm"
      />
      <input
        type="time"
        value={time}
        onChange={(e) => setTime(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
        aria-label="New period start time"
        className={TIME_INPUT_CLASS}
      />
      <Button
        size="sm"
        variant="outline"
        onClick={() => void submit()}
        disabled={!ready}
        className="h-8"
      >
        Add
      </Button>
    </div>
  )
}
