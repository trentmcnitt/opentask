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
import type { ReminderCreateInput } from '@/hooks/useReminders'
import { useTimeSlots } from '@/hooks/useTimeSlots'
import { useTimezone } from '@/hooks/useTimezone'
import { cn } from '@/lib/utils'
import { PRIORITY_OPTIONS, getPriorityBadgeClasses } from '@/lib/priority'
import { currentSlot, parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import {
  describeCadence,
  describeTimeOfDay,
  buildSchedule,
  formatMinutes,
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
 * ONE component, three hosts. Trent (2026-09-05): "there should be a reminder
 * detail page but then we also need an accompanying modal that kind of works
 * the same way. It should all probably be based on the same component since
 * these are only variants of the same core." The Reminders bar's Details
 * opens this in a dialog (a bottom sheet on a phone) via
 * `ReminderDetailModal`; `/tasks/:id` renders the same thing full-page when
 * the task is a reminder; and with `create` set it is the new-reminder form.
 * All hand it the same props; only the chrome differs.
 *
 * WHY NOT THE TASK EDITOR: the quick panel offers snooze times, a date grid,
 * labels, projects, "schedule from completion", end conditions — none of
 * which mean anything for a thought, and the server refuses to snooze a
 * reminder anyway. A reminder has two settings worth a screen: WHICH DAYS it
 * comes up and WHEN in the day (its slot). Plus its wording, notes, and its
 * priority — which on this surface is prominence, not interruption: it sets
 * where a thought sits in its slot and how heavy it reads, never whether it
 * nags. Labels and projects stay on the row, untouched, and reappear the
 * moment the thought is made a task (none of Trent's 38 reminders carries a
 * label; 34 sit in one project).
 *
 * SEVERAL AT ONCE: with more than one reminder selected the same editor edits
 * their schedule and priority together. Wording and notes are one reminder's
 * own and disappear; the chips show what the selection agrees on and nothing
 * where it doesn't. Only what the user touches is applied, and each reminder
 * keeps the rest of its own rule: picking a slot moves a daily one and a
 * Tue/Thu one to that slot, still daily and still Tue/Thu. A one-time
 * thought keeps its time, as in the single editor. One request, one Undo.
 *
 * STAGED, LIKE THE QUICK PANEL: every change is staged locally and saved in
 * one request when Save is pressed. The dirty state is reported to the host
 * so it can guard navigation or dismissal. After a successful save the host
 * hands back the updated task and the staging resets against it; after a
 * failed one the staged edits stay put, so nothing typed is lost to a network
 * error.
 */
export interface ReminderDetailProps {
  /** One reminder, or several selected together; none when creating. */
  tasks: Task[]
  /** New-reminder mode: what was typed before the form opened, if anything. */
  create?: ReminderCreateDraft
  /**
   * The user's slots. The Reminders page already holds them and passes them
   * through; the task page passes nothing and this fetches them once.
   */
  timeSlots?: TimeSlot[]
  /**
   * One reminder: save the staged changes in one PATCH. Should reject on
   * failure (after reporting it) so the staged edits are kept rather than reset.
   */
  onSaveAll?: (changes: QuickActionPanelChanges) => void | Promise<void>
  /** Several: save in one request. Same contract. */
  onSaveMany?: (changes: ReminderBulkChanges) => void | Promise<void>
  /** New: create it. Same contract. */
  onCreate?: (input: ReminderCreateInput) => void | Promise<void>
  /** Consider the reminder(s) — the host removes them and closes or navigates. */
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

export interface ReminderCreateDraft {
  title: string
}

/** One reminder's new rule, for a bulk save. */
export interface ReminderRuleChange {
  id: number
  rrule: string | null
}

/** What a bulk save carries: rules per reminder, and what is shared by all. */
export interface ReminderBulkChanges {
  ids: number[]
  rules: ReminderRuleChange[]
  priority?: number
}

/**
 * A schedule being edited. `cadence: null` and `time: null` mean "the
 * selection disagrees here" when editing several; nothing is pressed and
 * nothing is applied unless the user picks.
 */
type DraftSchedule = Omit<ReminderSchedule, 'cadence'> & { cadence: ReminderCadence | null }

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

/** How many of a selection's titles the header lists before "and N more". */
const LISTED_TITLES = 3

/** A new reminder starts as a daily thought; its slot is filled in from the clock. */
const NEW_SCHEDULE: DraftSchedule = {
  cadence: 'daily',
  days: [],
  monthDay: 1,
  time: null,
  custom: null,
}

/** Same size steps the quick panel uses for a prominent title. */
function titleSizeClass(title: string): string {
  if (title.length <= 200) return 'text-lg'
  if (title.length <= 500) return 'text-base'
  return 'text-sm'
}

function sameCadence(a: DraftSchedule, b: DraftSchedule): boolean {
  if (a.cadence !== b.cadence) return false
  switch (a.cadence) {
    case 'weekly':
      return a.days.length === b.days.length && a.days.every((d, i) => d === b.days[i])
    case 'monthly':
      return a.monthDay === b.monthDay
    case 'custom':
      return a.custom === b.custom
    default:
      return true
  }
}

/** One reminder's stored schedule, what several agree on, or a new one's default. */
function baseFor(tasks: Task[], timezone: string): DraftSchedule {
  const schedules = tasks.map((t) => readSchedule(t, timezone))
  if (schedules.length === 0) return NEW_SCHEDULE
  if (schedules.length === 1) return schedules[0]
  const [first, ...rest] = schedules
  const cadenceAgrees = rest.every((s) => sameCadence(s, first))
  const timeAgrees = rest.every((s) => s.time === first.time)
  return {
    cadence: cadenceAgrees ? first.cadence : null,
    days: cadenceAgrees ? first.days : [],
    monthDay: cadenceAgrees ? first.monthDay : 1,
    custom: cadenceAgrees ? first.custom : null,
    time: timeAgrees ? first.time : null,
  }
}

/** The priority the selection agrees on, or null where it disagrees; 0 for a new one. */
function basePriorityFor(tasks: Task[]): number | null {
  if (tasks.length === 0) return 0
  const first = tasks[0].priority
  return tasks.every((t) => t.priority === first) ? first : null
}

export function ReminderDetail({
  tasks,
  create,
  timeSlots: providedSlots,
  onSaveAll,
  onSaveMany,
  onCreate,
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
  const creating = tasks.length === 0 && create !== undefined
  const single = tasks.length === 1 ? tasks[0] : null
  const bulk = tasks.length > 1
  const primaryId = tasks[0]?.id ?? 0

  // The schedule as stored (`base`) and as edited (`draft`); dirty when they
  // differ in meaning, not in spelling — a stored "FREQ=DAILY;INTERVAL=1"
  // reads the same as the "FREQ=DAILY" the editor would write. For several,
  // `base` is what they agree on.
  const [base, setBase] = useState<DraftSchedule>(() => baseFor(tasks, timezone))
  const [draft, setDraft] = useState<DraftSchedule>(base)
  const [basePriority, setBasePriority] = useState<number | null>(() => basePriorityFor(tasks))
  const [pendingPriority, setPendingPriority] = useState<number | null>(null)
  const [pendingTitle, setPendingTitle] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(create?.title ?? '')
  // undefined = untouched, null = cleared, string = new text (the quick panel's convention).
  const [pendingNotes, setPendingNotes] = useState<string | null | undefined>(undefined)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesDraft, setNotesDraft] = useState('')
  const [saving, setSaving] = useState(false)

  // Re-baseline only when the reminders themselves move on: the host hands
  // back a saved row (updated_at changes), the selection changes, or the
  // session's timezone resolves. A refresh that brings the same rows leaves
  // the staged edits alone.
  const version = `${tasks.map((t) => `${t.id}:${t.updated_at}`).join('|')}|${timezone}`
  const [seenVersion, setSeenVersion] = useState(version)
  if (version !== seenVersion) {
    setSeenVersion(version)
    const fresh = baseFor(tasks, timezone)
    setBase(fresh)
    setDraft(fresh)
    setBasePriority(basePriorityFor(tasks))
    setPendingPriority(null)
    setPendingTitle(null)
    setEditingTitle(false)
    setPendingNotes(undefined)
    setEditingNotes(false)
  }

  /**
   * A reminder that has no time of day (a new one, or a one-time thought with
   * no due time) gets one the moment it repeats: the slot that is current
   * right now, else the first slot, so the chip that lights up is the honest
   * answer to "when will this come up".
   */
  const defaultTime = useCallback((): number => {
    const slot = currentSlot(timeSlots, timezone) ?? timeSlots[0]
    return (slot ? parseHHMM(slot.start_time) : null) ?? 9 * 60
  }, [timeSlots, timezone])

  const title = creating ? titleDraft : (pendingTitle ?? single?.title ?? '')
  const notes = pendingNotes !== undefined ? pendingNotes : (single?.notes ?? null)
  const cadenceStaged = !sameCadence(draft, base)
  const timeStaged = draft.time !== base.time
  const scheduleDirty = cadenceStaged || timeStaged
  const priorityDirty = pendingPriority !== null && pendingPriority !== basePriority
  const displayPriority = pendingPriority ?? basePriority
  const titleDirty = creating
    ? titleDraft.trim() !== (create?.title ?? '')
    : pendingTitle !== null || (editingTitle && titleDraft.trim() !== (pendingTitle ?? title))
  const isDirty = scheduleDirty || titleDirty || priorityDirty || pendingNotes !== undefined
  // A new reminder's time is filled in from the clock, so it is only ever
  // shown and saved through `effectiveTime`; the draft's own time stays null
  // until a slot is picked.
  const effectiveTime = draft.time ?? (creating && draft.cadence !== 'once' ? defaultTime() : null)
  // A weekly schedule needs a day; a repeating one needs a time, which the
  // single editor always supplies and the bulk editor supplies per reminder.
  const complete =
    (draft.cadence === 'weekly' ? draft.days.length > 0 : true) &&
    (bulk || draft.cadence === 'once' || effectiveTime !== null) &&
    (!creating || titleDraft.trim().length > 0)

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

  /**
   * Several at once: each reminder's own schedule with only the staged parts
   * replaced. A staged time reaches the repeating ones; a one-time thought
   * keeps its time. Reminders whose rule would not change are left out, so
   * the request (and its Undo) touches exactly what moved.
   */
  const bulkRules = useCallback((): ReminderRuleChange[] => {
    if (!bulk) return []
    return tasks.flatMap((task) => {
      const own = readSchedule(task, timezone)
      const next: ReminderSchedule = {
        cadence: cadenceStaged && draft.cadence ? draft.cadence : own.cadence,
        days: cadenceStaged ? draft.days : own.days,
        monthDay: cadenceStaged ? draft.monthDay : own.monthDay,
        custom: own.custom,
        time: own.time,
      }
      if (timeStaged && draft.time !== null && next.cadence !== 'once') next.time = draft.time
      if (next.cadence !== 'once' && next.time === null) next.time = draft.time ?? defaultTime()
      return sameSchedule(next, own) ? [] : [{ id: task.id, rrule: buildSchedule(next) }]
    })
  }, [bulk, tasks, timezone, cadenceStaged, timeStaged, draft, defaultTime])
  const bulkRuleCount = bulk ? bulkRules().length : 0
  const bulkHasChanges = bulkRuleCount > 0 || priorityDirty

  const collect = useCallback((): QuickActionPanelChanges => {
    const changes: QuickActionPanelChanges = {}
    if (!single) return changes
    const stagedTitle =
      pendingTitle ?? (editingTitle && titleDraft.trim() ? titleDraft.trim() : null)
    if (stagedTitle !== null && stagedTitle !== single.title) changes.title = stagedTitle
    if (scheduleDirty && draft.cadence) {
      changes.rrule = buildSchedule({ ...draft, cadence: draft.cadence })
    }
    if (priorityDirty && pendingPriority !== null) changes.priority = pendingPriority
    if (pendingNotes !== undefined) changes.notes = pendingNotes
    return changes
  }, [
    single,
    pendingTitle,
    editingTitle,
    titleDraft,
    scheduleDirty,
    draft,
    priorityDirty,
    pendingPriority,
    pendingNotes,
  ])

  const createInput = useCallback((): ReminderCreateInput => {
    const cadence = draft.cadence ?? 'daily'
    const rrule =
      cadence === 'once' ? null : buildSchedule({ ...draft, cadence, time: effectiveTime })
    return {
      title: titleDraft.trim(),
      rrule,
      notes: pendingNotes ?? null,
      priority: pendingPriority ?? 0,
    }
  }, [draft, effectiveTime, titleDraft, pendingNotes, pendingPriority])

  const save = useCallback(
    async (extra: QuickActionPanelChanges = {}) => {
      setSaving(true)
      try {
        if (creating) {
          if (titleDraft.trim()) await onCreate?.(createInput())
        } else if (bulk) {
          const rules = bulkRules()
          if (rules.length > 0 || priorityDirty) {
            await onSaveMany?.({
              ids: tasks.map((t) => t.id),
              rules,
              priority: priorityDirty && pendingPriority !== null ? pendingPriority : undefined,
            })
          }
        } else {
          const changes = { ...collect(), ...extra }
          if (Object.keys(changes).length > 0) await onSaveAll?.(changes)
        }
      } catch {
        // The host has already reported the failure; the staged edits stay.
      } finally {
        setSaving(false)
      }
    },
    [
      creating,
      titleDraft,
      onCreate,
      createInput,
      bulk,
      bulkRules,
      priorityDirty,
      pendingPriority,
      tasks,
      onSaveMany,
      collect,
      onSaveAll,
    ],
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
    setPendingPriority(null)
    setPendingTitle(null)
    setEditingTitle(false)
    if (creating) setTitleDraft(create?.title ?? '')
    setPendingNotes(undefined)
    setEditingNotes(false)
  }, [base, creating, create?.title])

  /**
   * "Make this a task" goes out with whatever else is staged, as one change:
   * the item leaves this surface for the task editor, where project, labels
   * and the date live. The toast's Undo brings it back here. One at a time
   * only — changing what KIND of thing several items are in one tap is the
   * sort of bulk mistake §6 exists to avoid.
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
    if (!trimmed || !single) return
    setPendingTitle(trimmed === single.title ? null : trimmed)
  }

  // --- Schedule --------------------------------------------------------------

  const selectCadence = (cadence: ReminderCadence) => {
    setDraft((prev) => {
      if (prev.cadence === cadence) return prev
      const next: DraftSchedule = { ...prev, cadence }
      if (cadence === 'custom') next.custom = base.custom
      if (cadence === 'weekly') next.days = base.cadence === 'weekly' ? base.days : []
      if (cadence === 'monthly') next.monthDay = base.cadence === 'monthly' ? base.monthDay : 1
      // Several at once: a time is only ever applied when the user picks one,
      // so a selection with different times keeps them. A new one is filled
      // in from the clock through `effectiveTime` instead.
      if (single && cadence !== 'once' && next.time === null) next.time = defaultTime()
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
  const selectPriority = (value: number) => {
    setPendingPriority(value === basePriority ? null : value)
  }

  const cadences = useMemo(
    () =>
      base.cadence === 'custom'
        ? [...CADENCES, { id: 'custom' as const, label: 'Custom' }]
        : CADENCES,
    [base.cadence],
  )
  const selectedSlot = slotAtMinutes(effectiveTime, timeSlots)
  const onBoundary =
    effectiveTime !== null && timeSlots.some((s) => parseHHMM(s.start_time) === effectiveTime)
  const summary = summarize({ ...draft, time: effectiveTime }, bulk, timeSlots)

  // --- Notes -----------------------------------------------------------------

  const startNotesEdit = () => {
    setNotesDraft(notes ?? '')
    setEditingNotes(true)
  }
  const changeNotes = (value: string) => {
    setNotesDraft(value)
    const trimmed = value.trim() || null
    setPendingNotes(trimmed === (single?.notes ?? null) ? undefined : trimmed)
  }

  const kind = creating ? 'New reminder' : bulk ? `${tasks.length} reminders` : 'Reminder'

  return (
    <div
      className="space-y-4"
      data-reminder-detail={creating ? 'new' : bulk ? 'bulk' : primaryId}
      data-reminder-count={tasks.length}
    >
      {/* Wording — one reminder's own; several show which ones are in hand. */}
      <div className="space-y-1">
        {(showKind || bulk || creating) && (
          <p className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-semibold tracking-wider uppercase">
            <Lightbulb className="size-3" />
            {kind}
          </p>
        )}
        {bulk ? (
          <ul className="text-muted-foreground space-y-0.5 text-sm">
            {tasks.slice(0, LISTED_TITLES).map((t) => (
              <li key={t.id} className="truncate">
                {t.title}
              </li>
            ))}
            {tasks.length > LISTED_TITLES && (
              <li className="text-muted-foreground/70">and {tasks.length - LISTED_TITLES} more</li>
            )}
          </ul>
        ) : creating ? (
          <Textarea
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (complete && !saving) void handleSave()
              }
            }}
            placeholder="A thought to have at the right moment…"
            aria-label="Reminder text"
            className={cn(
              '-mx-2 max-h-48 min-h-0 resize-none overflow-y-auto rounded-sm border-transparent bg-transparent px-2 py-1 font-medium shadow-none',
              'hover:bg-muted/50 focus:bg-muted/50 focus-visible:border-transparent focus-visible:ring-0',
              titleSizeClass(titleDraft),
            )}
            autoFocus
          />
        ) : editingTitle ? (
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
          {summary}
        </p>
      </div>

      <RepeatsSection
        taskId={primaryId}
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
          taskId={primaryId}
          timeSlots={timeSlots}
          time={effectiveTime}
          selectedSlotId={selectedSlot?.id ?? null}
          onBoundary={onBoundary}
          onSelect={selectSlot}
        />
      )}

      <PrioritySection
        taskId={primaryId}
        value={displayPriority}
        dirty={priorityDirty}
        onSelect={selectPriority}
      />

      {!bulk && (
        <NotesSection
          taskId={primaryId}
          notes={notes}
          dirty={pendingNotes !== undefined}
          editing={editingNotes}
          draft={notesDraft}
          onStartEdit={startNotesEdit}
          onChange={changeNotes}
          onDone={() => setEditingNotes(false)}
        />
      )}

      {/* The same bar as the quick panel: Save, Reset, the green verb, Cancel.
          Four of them do not fit a phone's sheet in one row, so below `sm`
          they wrap two per row; the desktop dialog keeps a single row. */}
      <div className="flex flex-wrap gap-2 border-t pt-3 select-none [&>button]:grow [&>button]:basis-[calc(50%-0.25rem)] sm:[&>button]:basis-0">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={
            creating
              ? !complete || saving
              : !isDirty || !complete || saving || (bulk && !bulkHasChanges)
          }
        >
          {creating ? 'Add reminder' : 'Save'}
        </Button>
        <Button size="sm" variant="outline" onClick={reset} disabled={!isDirty}>
          Reset
        </Button>
        {onConsidered && !single?.done && (
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

      {!creating && (
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
          {single && (
            <button
              type="button"
              onClick={makeTask}
              disabled={saving}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Leave the Reminders surface and edit it as a task — project, labels, due date"
            >
              Make this a task
            </button>
          )}
          {onOpenPage && single && (
            <button
              type="button"
              onClick={onOpenPage}
              className="text-muted-foreground hover:text-foreground ml-auto transition-colors"
            >
              Open full page
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The one-line summary: "Every day · Evening". Editing several, a part the
 * selection disagrees on says so rather than picking a side.
 */
function summarize(draft: DraftSchedule, bulk: boolean, timeSlots: TimeSlot[]): string {
  const cadence =
    draft.cadence !== null ? describeCadence({ ...draft, cadence: draft.cadence }) : null
  const time =
    draft.time !== null
      ? describeTimeOfDay(draft.time, timeSlots)
      : bulk && draft.cadence !== 'once'
        ? 'different times'
        : null
  if (bulk && cadence === null && draft.time === null) return 'Different schedules'
  return [cadence ?? 'Different days', time].filter(Boolean).join(' · ')
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
  draft: DraftSchedule
  base: DraftSchedule
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
            title={
              c.id === 'custom' && base.custom
                ? describeCadence({ ...base, cadence: 'custom' })
                : undefined
            }
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

/**
 * The same five values and colours as a task's priority. On this surface it
 * is prominence: order within the slot and weight of the row, never a nag.
 */
function PrioritySection({
  taskId,
  value,
  dirty,
  onSelect,
}: {
  taskId: number
  value: number | null
  dirty: boolean
  onSelect: (value: number) => void
}) {
  return (
    <section className="space-y-2" aria-labelledby={`priority-${taskId}`}>
      <SectionHeading id={`priority-${taskId}`}>
        Priority
        {dirty && <span className="ml-1 text-blue-500">●</span>}
      </SectionHeading>
      <div className="flex flex-wrap gap-1.5">
        {PRIORITY_OPTIONS.map((option) => {
          const selected = value === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              data-priority-chip={option.value}
              onClick={() => onSelect(option.value)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                getPriorityBadgeClasses(option.value, selected ? 'included' : 'unselected'),
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
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
