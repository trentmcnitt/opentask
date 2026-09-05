'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Check, Lightbulb, Pencil, Repeat, Trash2 } from 'lucide-react'
import { DateTime } from 'luxon'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { useTimeSlots } from '@/hooks/useTimeSlots'
import { useTimezone } from '@/hooks/useTimezone'
import { cn } from '@/lib/utils'
import { currentSlot, parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import {
  describeCadence,
  describeTimeOfDay,
  buildSchedule,
  formatMinutes,
  isCompleteSchedule,
  readSchedule,
  sameSchedule,
  slotAtMinutes,
  type ReminderCadence,
  type ReminderSchedule,
} from '@/lib/reminder-rule'
import type { Task } from '@/types'

/**
 * A reminder's own details (REDESIGN-V03 §6).
 *
 * ONE component, two hosts. Trent (2026-09-05): "there should be a reminder
 * detail page but then we also need an accompanying modal that kind of works
 * the same way. It should all probably be based on the same component since
 * these are only variants of the same core." The Reminders bar's Details
 * opens this in a dialog (a bottom sheet on a phone) via
 * `ReminderDetailModal`; `/tasks/:id` renders the same thing full-page when
 * the task is a reminder. Both hand it the same props; only the chrome differs.
 *
 * WHY NOT THE TASK EDITOR: the quick panel offers snooze times, a date grid,
 * priority, "schedule from completion", end conditions — none of which mean
 * anything for a thought, and the server refuses to snooze a reminder anyway.
 * A reminder has exactly two settings worth a screen: WHICH DAYS it comes up
 * and WHEN in the day (its slot). Plus its wording and notes. That is all
 * this shows. Project, labels and priority are reachable by making it a task.
 *
 * STAGED, LIKE THE QUICK PANEL: every change is staged locally and saved in
 * one PATCH (one undo entry) when Save is pressed. The dirty state is
 * reported to the host so it can guard navigation or dismissal. After a
 * successful save the host hands back the updated task and the staging
 * resets against it; after a failed one the staged edits stay put, so nothing
 * typed is lost to a network error.
 */
export interface ReminderDetailProps {
  task: Task
  /**
   * The user's slots. The Reminders page already holds them and passes them
   * through; the task page passes nothing and this fetches them once.
   */
  timeSlots?: TimeSlot[]
  /**
   * Save the staged changes in one request. Should reject on failure (after
   * reporting it) so the staged edits are kept rather than reset.
   */
  onSaveAll: (changes: QuickActionPanelChanges) => void | Promise<void>
  /** Consider this reminder — the host removes it and closes or navigates. */
  onConsidered?: () => void
  /** Move to Trash — a soft delete with Undo, handled by the host. */
  onDelete?: () => void
  /** Modal host only: dismiss, dropping staged edits. */
  onCancel?: () => void
  /** Modal host only: continue on the full page. */
  onOpenPage?: () => void
  /** Modal host only: show the "Reminder" eyebrow, since there is no page header saying so. */
  showKind?: boolean
  onDirtyChange?: (dirty: boolean) => void
  /** Populated with the save function so a host's unsaved-changes dialog can call it. */
  saveRef?: MutableRefObject<(() => Promise<void> | void) | null>
}

const CADENCES: ReadonlyArray<{ id: ReminderCadence; label: string }> = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'once', label: 'Once' },
]

const WEEKDAYS = [
  { dow: 0, short: 'M', full: 'Monday' },
  { dow: 1, short: 'T', full: 'Tuesday' },
  { dow: 2, short: 'W', full: 'Wednesday' },
  { dow: 3, short: 'T', full: 'Thursday' },
  { dow: 4, short: 'F', full: 'Friday' },
  { dow: 5, short: 'S', full: 'Saturday' },
  { dow: 6, short: 'S', full: 'Sunday' },
]

/** Same size steps the quick panel uses for a prominent title. */
function titleSizeClass(title: string): string {
  if (title.length <= 200) return 'text-lg'
  if (title.length <= 500) return 'text-base'
  return 'text-sm'
}

export function ReminderDetail({
  task,
  timeSlots: providedSlots,
  onSaveAll,
  onConsidered,
  onDelete,
  onCancel,
  onOpenPage,
  showKind = false,
  onDirtyChange,
  saveRef,
}: ReminderDetailProps) {
  const timezone = useTimezone()
  const fetched = useTimeSlots(providedSlots)
  const timeSlots = providedSlots ?? fetched.timeSlots

  // The schedule as stored (`base`) and as edited (`draft`); dirty when they
  // differ in meaning, not in spelling — a stored "FREQ=DAILY;INTERVAL=1"
  // reads the same as the "FREQ=DAILY" the editor would write.
  const [base, setBase] = useState<ReminderSchedule>(() => readSchedule(task, timezone))
  const [draft, setDraft] = useState<ReminderSchedule>(base)
  const [pendingTitle, setPendingTitle] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  // undefined = untouched, null = cleared, string = new text (the quick panel's convention).
  const [pendingNotes, setPendingNotes] = useState<string | null | undefined>(undefined)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesDraft, setNotesDraft] = useState('')
  const [saving, setSaving] = useState(false)

  // Re-baseline only when the task itself moves on: the host hands back the
  // saved row (updated_at changes) or the session's timezone resolves. A
  // refresh that brings the same row leaves the staged edits alone.
  const version = `${task.updated_at}|${timezone}`
  const [seenVersion, setSeenVersion] = useState(version)
  if (version !== seenVersion) {
    setSeenVersion(version)
    const fresh = readSchedule(task, timezone)
    setBase(fresh)
    setDraft(fresh)
    setPendingTitle(null)
    setEditingTitle(false)
    setPendingNotes(undefined)
    setEditingNotes(false)
  }

  const title = pendingTitle ?? task.title
  const notes = pendingNotes !== undefined ? pendingNotes : task.notes
  const scheduleDirty = !sameSchedule(draft, base)
  const titleDirty =
    pendingTitle !== null || (editingTitle && titleDraft.trim() !== (pendingTitle ?? task.title))
  const isDirty = scheduleDirty || titleDirty || pendingNotes !== undefined
  const complete = isCompleteSchedule(draft)

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // Leaving reports clean: "Make this a task" swaps this editor out for the
  // task editor mid-flight, and a host still holding "dirty" for an editor
  // that no longer exists would guard navigation for nothing. A ref keeps the
  // cleanup to unmount only — firing it on every dirty change would also
  // release a deferred refresh while the user is still editing.
  const onDirtyChangeRef = useRef(onDirtyChange)
  onDirtyChangeRef.current = onDirtyChange
  useEffect(() => {
    return () => onDirtyChangeRef.current?.(false)
  }, [])

  // Browser-level guard for a reload or tab close with staged edits.
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = 'You have unsaved changes. Are you sure you want to leave?'
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  const collect = useCallback((): QuickActionPanelChanges => {
    const changes: QuickActionPanelChanges = {}
    const stagedTitle =
      pendingTitle ?? (editingTitle && titleDraft.trim() ? titleDraft.trim() : null)
    if (stagedTitle !== null && stagedTitle !== task.title) changes.title = stagedTitle
    if (scheduleDirty) changes.rrule = buildSchedule(draft)
    if (pendingNotes !== undefined) changes.notes = pendingNotes
    return changes
  }, [pendingTitle, editingTitle, titleDraft, task.title, scheduleDirty, draft, pendingNotes])

  const save = useCallback(
    async (extra: QuickActionPanelChanges = {}) => {
      const changes = { ...collect(), ...extra }
      if (Object.keys(changes).length === 0) return
      setSaving(true)
      try {
        await onSaveAll(changes)
      } catch {
        // The host has already reported the failure; the staged edits stay.
      } finally {
        setSaving(false)
      }
    },
    [collect, onSaveAll],
  )

  const handleSave = useCallback(() => save(), [save])

  useEffect(() => {
    if (!saveRef) return
    saveRef.current = handleSave
    return () => {
      saveRef.current = null
    }
  }, [saveRef, handleSave])

  const reset = useCallback(() => {
    setDraft(base)
    setPendingTitle(null)
    setEditingTitle(false)
    setPendingNotes(undefined)
    setEditingNotes(false)
  }, [base])

  /**
   * "Make this a task" goes out with whatever else is staged, as one change:
   * the item leaves this surface for the task editor, where project, labels
   * and priority live. The toast's Undo brings it back here.
   */
  const makeTask = useCallback(() => save({ is_reminder: false }), [save])

  // --- Title -----------------------------------------------------------------

  const startTitleEdit = () => {
    setTitleDraft(title)
    setEditingTitle(true)
  }
  const commitTitle = () => {
    const trimmed = titleDraft.trim()
    setEditingTitle(false)
    if (!trimmed) return
    setPendingTitle(trimmed === task.title ? null : trimmed)
  }

  // --- Schedule --------------------------------------------------------------

  /**
   * A reminder that had no time of day (a one-time thought with no due time)
   * gets one the moment it starts repeating: the slot that is current right
   * now, else the first slot, so the chip that lights up is the honest answer
   * to "when will this come up".
   */
  const defaultTime = useCallback((): number => {
    const slot = currentSlot(timeSlots, timezone) ?? timeSlots[0]
    return (slot ? parseHHMM(slot.start_time) : null) ?? 9 * 60
  }, [timeSlots, timezone])

  const selectCadence = (cadence: ReminderCadence) => {
    setDraft((prev) => {
      if (prev.cadence === cadence) return prev
      const next: ReminderSchedule = { ...prev, cadence }
      if (cadence === 'custom') next.custom = base.custom
      if (cadence === 'weekly') next.days = base.cadence === 'weekly' ? base.days : []
      if (cadence === 'monthly') next.monthDay = base.cadence === 'monthly' ? base.monthDay : 1
      if (cadence !== 'once' && next.time === null) next.time = defaultTime()
      return next
    })
  }
  const toggleDay = (dow: number) => {
    setDraft((prev) => ({
      ...prev,
      days: prev.days.includes(dow)
        ? prev.days.filter((d) => d !== dow)
        : [...prev.days, dow].sort((a, b) => a - b),
    }))
  }
  const selectSlot = (slot: TimeSlot) => {
    const minutes = parseHHMM(slot.start_time)
    if (minutes === null) return
    setDraft((prev) => ({ ...prev, time: minutes }))
  }

  const cadences = useMemo(
    () =>
      base.cadence === 'custom'
        ? [...CADENCES, { id: 'custom' as const, label: 'Custom' }]
        : CADENCES,
    [base.cadence],
  )
  const selectedSlot = slotAtMinutes(draft.time, timeSlots)
  const onBoundary =
    draft.time !== null && timeSlots.some((s) => parseHHMM(s.start_time) === draft.time)
  const timeText = describeTimeOfDay(draft.time, timeSlots)

  // --- Notes -----------------------------------------------------------------

  const startNotesEdit = () => {
    setNotesDraft(notes ?? '')
    setEditingNotes(true)
  }
  const changeNotes = (value: string) => {
    setNotesDraft(value)
    const trimmed = value.trim() || null
    setPendingNotes(trimmed === task.notes ? undefined : trimmed)
  }

  return (
    <div className="space-y-4" data-reminder-detail={task.id}>
      {/* Wording */}
      <div className="space-y-1">
        {showKind && (
          <p className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-semibold tracking-wider uppercase">
            <Lightbulb className="size-3" />
            Reminder
          </p>
        )}
        {editingTitle ? (
          <Textarea
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                commitTitle()
              }
              if (e.key === 'Escape') setEditingTitle(false)
            }}
            aria-label="Reminder text"
            className={cn(
              '-mx-2 max-h-48 min-h-0 resize-none overflow-y-auto rounded-sm border-transparent bg-transparent px-2 py-1 font-medium shadow-none',
              'hover:bg-muted/50 focus:bg-muted/50 focus-visible:border-transparent focus-visible:ring-0',
              titleSizeClass(titleDraft),
            )}
            autoFocus
          />
        ) : (
          <p
            onClick={startTitleEdit}
            className={cn(
              'hover:text-primary cursor-pointer font-medium text-pretty transition-colors',
              titleSizeClass(title),
              pendingTitle !== null && 'text-blue-500',
            )}
          >
            {title}
          </p>
        )}
        <p
          className={cn(
            'text-xs select-text',
            scheduleDirty ? 'font-medium text-blue-500' : 'text-muted-foreground',
          )}
          data-reminder-summary
        >
          <Repeat className="mr-1 inline size-3" />
          {describeCadence(draft)}
          {timeText && <> &middot; {timeText}</>}
        </p>
      </div>

      <RepeatsSection
        taskId={task.id}
        draft={draft}
        base={base}
        cadences={cadences}
        onCadence={selectCadence}
        onToggleDay={toggleDay}
        onMonthDay={(monthDay) => setDraft((prev) => ({ ...prev, monthDay }))}
      />

      {/* When in the day — a one-time thought keeps whatever time it has. */}
      {draft.cadence !== 'once' && (
        <TimeOfDaySection
          taskId={task.id}
          timeSlots={timeSlots}
          time={draft.time}
          selectedSlotId={selectedSlot?.id ?? null}
          onBoundary={onBoundary}
          onSelect={selectSlot}
        />
      )}

      <NotesSection
        taskId={task.id}
        notes={notes}
        dirty={pendingNotes !== undefined}
        editing={editingNotes}
        draft={notesDraft}
        onStartEdit={startNotesEdit}
        onChange={changeNotes}
        onDone={() => setEditingNotes(false)}
      />

      {/* The same bar as the quick panel: Save, Reset, the green verb, Cancel.
          Four of them do not fit a phone's sheet in one row, so below `sm`
          they wrap two per row; the desktop dialog keeps a single row. */}
      <div className="flex flex-wrap gap-2 border-t pt-3 select-none [&>button]:grow [&>button]:basis-[calc(50%-0.25rem)] sm:[&>button]:basis-0">
        <Button size="sm" onClick={handleSave} disabled={!isDirty || !complete || saving}>
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={reset} disabled={!isDirty}>
          Reset
        </Button>
        {onConsidered && !task.done && (
          <Button
            size="sm"
            onClick={onConsidered}
            className="bg-green-600 text-white hover:bg-green-700 active:bg-green-700"
          >
            <Check className="mr-1 size-4" />
            Considered
          </Button>
        )}
        {onCancel && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              reset()
              onCancel()
            }}
          >
            Cancel
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="text-destructive/80 hover:text-destructive inline-flex items-center gap-1 transition-colors"
          >
            <Trash2 className="size-3" />
            Move to Trash
          </button>
        )}
        <button
          type="button"
          onClick={makeTask}
          disabled={saving}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Leave the Reminders surface and edit it as a task — project, labels, priority, due date"
        >
          Make this a task
        </button>
        {onOpenPage && (
          <button
            type="button"
            onClick={onOpenPage}
            className="text-muted-foreground hover:text-foreground ml-auto transition-colors"
          >
            Open full page
          </button>
        )}
      </div>
    </div>
  )
}

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
      {children}
    </h3>
  )
}

function RepeatsSection({
  taskId,
  draft,
  base,
  cadences,
  onCadence,
  onToggleDay,
  onMonthDay,
}: {
  taskId: number
  draft: ReminderSchedule
  base: ReminderSchedule
  cadences: ReadonlyArray<{ id: ReminderCadence; label: string }>
  onCadence: (cadence: ReminderCadence) => void
  onToggleDay: (dow: number) => void
  onMonthDay: (monthDay: number | 'last') => void
}) {
  return (
    <section className="space-y-2" aria-labelledby={`repeats-${taskId}`}>
      <SectionHeading id={`repeats-${taskId}`}>Repeats</SectionHeading>
      <div className="flex flex-wrap gap-1.5">
        {cadences.map((c) => (
          <Button
            key={c.id}
            type="button"
            size="sm"
            variant={draft.cadence === c.id ? 'default' : 'outline'}
            aria-pressed={draft.cadence === c.id}
            data-cadence={c.id}
            onClick={() => onCadence(c.id)}
            className="rounded-full"
            title={c.id === 'custom' && base.custom ? describeCadence(base) : undefined}
          >
            {c.label}
          </Button>
        ))}
      </div>
      {draft.cadence === 'weekly' && (
        <div className="flex flex-wrap items-center gap-1">
          {WEEKDAYS.map((day) => (
            <Button
              key={day.dow}
              type="button"
              size="icon"
              variant={draft.days.includes(day.dow) ? 'default' : 'outline'}
              aria-pressed={draft.days.includes(day.dow)}
              aria-label={day.full}
              data-weekday={day.dow}
              onClick={() => onToggleDay(day.dow)}
              className="h-8 w-8 text-xs"
            >
              {day.short}
            </Button>
          ))}
          {draft.days.length === 0 && (
            <p className="text-destructive w-full text-xs">Pick at least one day</p>
          )}
        </div>
      )}
      {draft.cadence === 'monthly' && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">On day</span>
          <Select
            value={String(draft.monthDay)}
            onValueChange={(v) => onMonthDay(v === 'last' ? 'last' : parseInt(v, 10))}
          >
            <SelectTrigger className="w-28" aria-label="Day of the month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d}
                </SelectItem>
              ))}
              <SelectItem value="last">Last day</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </section>
  )
}

function TimeOfDaySection({
  taskId,
  timeSlots,
  time,
  selectedSlotId,
  onBoundary,
  onSelect,
}: {
  taskId: number
  timeSlots: TimeSlot[]
  time: number | null
  selectedSlotId: number | null
  onBoundary: boolean
  onSelect: (slot: TimeSlot) => void
}) {
  return (
    <section className="space-y-2" aria-labelledby={`slot-${taskId}`}>
      <SectionHeading id={`slot-${taskId}`}>Time of day</SectionHeading>
      <div className="flex flex-wrap gap-1.5">
        {timeSlots.map((slot) => {
          const selected = selectedSlotId === slot.id
          return (
            <Button
              key={slot.id}
              type="button"
              size="sm"
              variant={selected ? 'default' : 'outline'}
              aria-pressed={selected}
              data-slot-chip={slot.id}
              data-slot-label={slot.label}
              onClick={() => onSelect(slot)}
              className="rounded-full"
            >
              {slot.label}
              <span className={cn('text-xs', selected ? 'opacity-80' : 'text-muted-foreground')}>
                {formatSlotStart(slot.start_time)}
              </span>
            </Button>
          )
        })}
      </div>
      {time !== null && !onBoundary && (
        <p className="text-muted-foreground text-xs">
          Set for {formatMinutes(time)}. Choosing a slot moves it to that slot&apos;s start.
        </p>
      )}
    </section>
  )
}

function NotesSection({
  taskId,
  notes,
  dirty,
  editing,
  draft,
  onStartEdit,
  onChange,
  onDone,
}: {
  taskId: number
  notes: string | null
  dirty: boolean
  editing: boolean
  draft: string
  onStartEdit: () => void
  onChange: (value: string) => void
  onDone: () => void
}) {
  return (
    <section className="space-y-1.5" aria-labelledby={`notes-${taskId}`}>
      <div className="flex items-center justify-between">
        <SectionHeading id={`notes-${taskId}`}>Notes</SectionHeading>
        {!editing && notes && (
          <button
            type="button"
            onClick={onStartEdit}
            aria-label="Edit notes"
            className="text-muted-foreground hover:text-foreground"
          >
            <Pencil className="size-3.5" />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <Textarea
            value={draft}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Add notes..."
            aria-label="Notes"
            className="min-h-[72px] text-sm"
            autoFocus
          />
          <Button size="xs" variant="outline" onClick={onDone}>
            Done
          </Button>
        </div>
      ) : notes ? (
        <p
          className={cn(
            'text-sm whitespace-pre-wrap',
            dirty ? 'text-blue-500' : 'text-muted-foreground',
          )}
        >
          {notes}
        </p>
      ) : (
        <button
          type="button"
          onClick={onStartEdit}
          className="text-muted-foreground hover:text-foreground text-xs transition-colors"
        >
          + Add notes...
        </button>
      )}
    </section>
  )
}

/** "07:00" → "7:00 AM"; the raw value if it isn't HH:MM. */
function formatSlotStart(startTime: string): string {
  const parsed = DateTime.fromFormat(startTime, 'HH:mm')
  return parsed.isValid ? parsed.toFormat('h:mm a') : startTime
}
