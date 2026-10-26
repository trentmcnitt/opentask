'use client'

import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChevronLeft, ChevronRight, Minus, Plus, Repeat } from 'lucide-react'
import { openTaskDayOf } from '@/lib/opentask-day'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ENDS_BEFORE_NEXT,
  daysBeforeChoices,
  draftRule,
  nextDateWords,
  nextDates,
  targetTimeRefused,
  thisOneHint,
  type DraftAction,
  type EveryTimeContext,
  type EveryTimeDraft,
  type EveryTimeTask,
  upcomingLeadStep,
  upcomingLeadStepWords,
  leadResetForRule,
  LEAD_RESET_FOR_RULE,
} from '@/lib/every-time'
import { leadDaysWords, repeatWords } from '@/lib/editor-target-labels'
import {
  RELATIVE_TARGET_MESSAGES,
  defaultLeadDays,
  repeatEndOf,
  ruleWait,
} from '@/lib/task-segments'
import { DEADLINE_WORD, LEAD_WORD, TARGET_WORD } from '@/lib/task-model-words'
import { HowOftenField } from '@/components/quick-panel/HowOftenField'
import { EndsField } from '@/components/quick-panel/EndsField'
import { TimeSelect } from '@/components/quick-panel/TimeSelect'
import { RelativeTargetControl } from '@/components/quick-panel/RelativeTargetControl'
import type { SlotChoice } from '@/lib/relative-target-ui'

/** The id the this-one link points `aria-controls` at. */
export const EVERY_TIME_REGION_ID = 'quick-panel-every-time'

export type EveryTimeVariant = 'single' | 'create' | 'bulk'

/**
 * THE QUICK PANEL'S "EVERY TIME" MODE (2026-10-22, editor plan §4, mock E;
 * PR 4c). The panel edits a repeating task in two modes: THIS ONE (the
 * default — this occurrence's target, deadline, deck) and EVERY TIME (the
 * schedule). This is the second: a teal banner ("EDITING EVERY TIME ‹ Back
 * to this one" — teal is the MODE, blue stays "unsaved") across the top of
 * the surface the panel is in, then
 *   Repeats on [Target | Deadline] · How often · the anchor's time, then the
 *   other date (deadline-anchored: Deadline [8:00 AM] then Target [the day
 *   before ▾] at [6:00 PM ▾]; target-anchored: Target [4:00 PM] then
 *   Deadline [+ Add]) · Ends · More options › Schedule from · Next (three
 *   dates) · the hint · the problem · Stop repeating · Save / Reset / Cancel.
 * No pad, no Done, no chip row, no notes: this mode edits the schedule only,
 * and one Save is one PATCH and one undo entry (`draftToPatch`).
 *
 * Everything it decides is the pure `src/lib/every-time.ts` (tested there):
 * the reducer, the patch, the problem (the SERVER'S planner and end check,
 * so a 400 can only come from a race), Next, the greyed choices and the hint.
 * This component only lays them out.
 *
 * NO FRAME OF ITS OWN (2026-10-24, Trent: "a rectangle inside a rectangle"):
 * it sits straight on its host's surface — the dialog, the sheet, or the
 * page's card (`DirtyCard`) — like this-one mode. The banner alone marks the
 * mode; a teal border around the rows made a third nested box.
 *
 * Variants: `create` (the task doesn't exist yet: the button is Done — it
 * stages the draft and goes back, A7); `bulk` (several tasks, A11: Repeats on
 * fixed to Target, no Deadline row, no Ends — bulk/edit refuses ends — and no
 * per-task hint).
 */
export function EveryTimePanel({
  variant,
  title,
  task,
  initial,
  draft,
  dispatch,
  ctx,
  bulkCount = 0,
  focusDeadline,
  canStop,
  locked,
  problem,
  saveable,
  saving,
  slots = [],
  headingRef,
  onBack,
  onSave,
  onReset,
  onCancel,
}: {
  variant: EveryTimeVariant
  title: ReactNode
  /** The task the checks read (create: the staged one-off; bulk: a stand-in). */
  task: EveryTimeTask
  /** The draft every-time opened with (Reset goes back to it; blue = differs). */
  initial: EveryTimeDraft
  draft: EveryTimeDraft
  dispatch: (action: DraftAction) => void
  ctx: EveryTimeContext
  bulkCount?: number
  /** Opened from a target-anchored repeat's Deadline row: "+ Add" has focus. */
  focusDeadline: boolean
  /** "Stop repeating" is offered: the task (or a selected one, or the staged create) repeats. */
  canStop: boolean
  /**
   * The rule is one the draft can't hold (`scheduleEditable`): shown in
   * words, read-only — "This repeat can't be edited here" — with Stop
   * repeating only; nothing rebuilds it.
   */
  locked: boolean
  /** Why Save is disabled (`draftProblem`, asked once by `useEveryTime`). */
  problem: string | null
  /** The Save would send something (create: always — Done stages the draft). */
  saveable: boolean
  saving: boolean
  /**
   * The periods a deadline-anchored target may follow (relative targets,
   * 2026-10-24): the user's own, or none on a task someone else owns.
   */
  slots?: readonly SlotChoice[]
  headingRef: RefObject<HTMLHeadingElement | null>
  onBack: () => void
  onSave: () => void
  onReset: () => void
  onCancel: () => void
}) {
  const headingId = useId()
  const problemId = useId()
  const next = useMemo(
    () => (locked ? null : nextDates(task, draft, ctx)),
    [locked, task, draft, ctx],
  )
  const hint = useMemo(() => {
    if (variant === 'bulk') return `Changes apply to all ${bulkCount} selected tasks.`
    if (variant === 'create' || (locked && !draft.stop)) return null
    return thisOneHint(task, draft, ctx)
  }, [variant, bulkCount, locked, task, draft, ctx])
  const stopped = draft.stop
  const saveDisabled = !!problem || saving || (variant !== 'create' && !saveable)
  const shownProblem = stopped || locked ? null : (draft.refusal ?? problem)

  return (
    <section
      id={EVERY_TIME_REGION_ID}
      role="region"
      aria-labelledby={headingId}
      data-every-time
      className="space-y-3"
    >
      <Banner headingId={headingId} headingRef={headingRef} onBack={onBack} />
      <div className="space-y-3">
        {title}
        {locked ? (
          <LockedRule task={task} stopped={stopped} />
        ) : (
          <ScheduleRows
            variant={variant}
            task={task}
            initial={initial}
            draft={draft}
            dispatch={dispatch}
            ctx={ctx}
            focusDeadline={focusDeadline}
            slots={slots}
          />
        )}
        {next && <NextLine next={next} timezone={ctx.timezone} hidden={stopped || !!problem} />}
        {hint && (
          <p data-every-time-hint className="text-muted-foreground text-xs">
            {hint}
          </p>
        )}
        {shownProblem && (
          <p
            id={problemId}
            role="alert"
            data-every-time-problem
            className="text-destructive text-xs font-medium"
          >
            {shownProblem}
          </p>
        )}
        <StopRepeating
          stopped={stopped}
          show={canStop}
          onToggle={() => dispatch({ type: 'stop', stop: !stopped })}
        />
        <div className="flex gap-2 border-t pt-3 select-none">
          <Button
            variant="default"
            size="sm"
            onClick={onSave}
            disabled={saveDisabled}
            aria-describedby={shownProblem ? problemId : undefined}
            className="flex-1"
          >
            {variant === 'create' ? 'Done' : 'Save'}
          </Button>
          <Button variant="outline" size="sm" onClick={onReset} className="flex-1">
            Reset
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel} className="flex-1">
            Cancel
          </Button>
        </div>
      </div>
    </section>
  )
}

/**
 * The banner: sticky at the top of a scrolling sheet (§11), so the way back
 * is always in reach; the heading takes focus on entry (§12). Text, not
 * colour alone, names the mode.
 */
function Banner({
  headingId,
  headingRef,
  onBack,
}: {
  headingId: string
  headingRef: RefObject<HTMLHeadingElement | null>
  onBack: () => void
}) {
  return (
    <div className="bg-every-time text-every-time-foreground sticky top-0 z-10 flex items-center justify-between gap-2 rounded-md pl-3">
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="flex items-center gap-1.5 text-xs font-bold tracking-wide uppercase outline-none"
      >
        <Repeat className="size-3.5" aria-hidden />
        {/* "EVERY TIME" on a phone (one line at 375px), the whole phrase
            from sm up; the heading's name is "Editing every time" at both. */}
        <span>
          <span className="sr-only sm:not-sr-only">Editing </span>every time
        </span>
      </h2>
      <button
        type="button"
        onClick={onBack}
        data-every-time-back
        className="flex h-11 shrink-0 items-center gap-0.5 px-3 text-xs font-semibold whitespace-nowrap hover:underline"
      >
        <ChevronLeft className="size-3.5" aria-hidden />
        <span>
          Back<span className="sr-only sm:not-sr-only"> to this one</span>
        </span>
      </button>
    </div>
  )
}

/**
 * The schedule's rows (mock E): Repeats on · How often · the anchor's time ·
 * the other date · Ends · More options › Schedule from. A changed value is
 * blue (it differs from what the mode opened with); "Stop repeating" greys
 * them all.
 */
function ScheduleRows({
  variant,
  task,
  initial,
  draft,
  dispatch,
  ctx,
  focusDeadline,
  slots,
}: {
  variant: EveryTimeVariant
  task: EveryTimeTask
  initial: EveryTimeDraft
  draft: EveryTimeDraft
  dispatch: (action: DraftAction) => void
  ctx: EveryTimeContext
  focusDeadline: boolean
  slots: readonly SlotChoice[]
}) {
  const [moreOpen, setMoreOpen] = useState(initial.mode === 'from_completion')
  const choices = useMemo(() => daysBeforeChoices(task, draft, ctx), [task, draft, ctx])
  const stopped = draft.stop
  const deadline = draft.anchor === 'deadline'
  const differs = (k: keyof EveryTimeDraft) =>
    JSON.stringify(draft[k]) !== JSON.stringify(initial[k])
  const ruleDiffers = (...keys: Array<keyof EveryTimeDraft['rule']>) =>
    keys.some((k) => JSON.stringify(draft.rule[k]) !== JSON.stringify(initial.rule[k]))
  const stored = repeatEndOf(task)
  // The repeat-until picker's earliest date: today's OpenTask date (at 00:30
  // with a 3:00 AM start, still yesterday's — a repeat can end on it).
  const today = openTaskDayOf(ctx.now, ctx.timezone, ctx.dayStart)
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-x-3 gap-y-2.5 text-sm sm:grid-cols-[5.5rem_1fr] sm:items-center',
        stopped && 'pointer-events-none opacity-50',
      )}
      aria-disabled={stopped || undefined}
    >
      {variant !== 'bulk' && (
        <Row label="Repeats on">
          <AnchorSegment
            anchor={draft.anchor}
            dirty={differs('anchor')}
            disabled={stopped}
            onChange={(anchor) => dispatch({ type: 'anchor', anchor, ctx })}
          />
        </Row>
      )}
      <Row label="How often">
        <HowOftenField
          rule={draft.rule}
          fromCompletion={draft.mode === 'from_completion'}
          disabled={stopped}
          dirty={{
            freq: ruleDiffers('freq'),
            interval: ruleDiffers('interval'),
            days: ruleDiffers('days'),
            monthDay: ruleDiffers('monthDay', 'monthWeekday'),
          }}
          onFreq={(freq) => dispatch({ type: 'freq', freq })}
          onInterval={(interval) => dispatch({ type: 'interval', interval })}
          onToggleDay={(day) => dispatch({ type: 'toggleDay', day })}
          onMonthDay={(day) => dispatch({ type: 'monthDay', day })}
        />
      </Row>
      <Row label={deadline ? DEADLINE_WORD : TARGET_WORD}>
        <TimeSelect
          label={deadline ? 'Deadline time' : 'Target time'}
          value={deadline ? (draft.deadlineTime ?? '') : draft.targetTime}
          dirty={differs(deadline ? 'deadlineTime' : 'targetTime')}
          disabled={stopped}
          testId={deadline ? 'every-time-deadline-time' : 'every-time-target-time'}
          onChange={(time) => dispatch({ type: deadline ? 'deadlineTime' : 'targetTime', time })}
        />
      </Row>
      {deadline ? (
        draft.noTarget ? (
          <NoTargetRow task={task} draft={draft} initial={initial} ctx={ctx} dispatch={dispatch} />
        ) : (
          <RelativeTargetRow
            draft={draft}
            initial={initial}
            choices={choices}
            slots={slots}
            dispatch={dispatch}
          />
        )
      ) : variant === 'bulk' ? null : (
        <Row label={DEADLINE_WORD}>
          <AddDeadline
            autoFocus={focusDeadline}
            disabled={stopped}
            onPick={(time) => dispatch({ type: 'addDeadline', time, ctx })}
          />
        </Row>
      )}
      {/* Upcoming's lead (2026-10-25): any repeat with a target; the
          deadlines page's draft (no target) has its own, in NoTargetRow. */}
      {variant !== 'bulk' && (
        <UpcomingLeadRow
          task={task}
          draft={draft}
          initial={initial}
          ctx={ctx}
          dispatch={dispatch}
        />
      )}
      {variant !== 'bulk' && (
        <Row label="Ends">
          <EndsField
            rule={draft.rule}
            storedCount={stored.repeat_count}
            used={stored.repeat_count_used}
            today={today}
            dirty={ruleDiffers('endType', 'endCount', 'endDate')}
            disabled={stopped}
            onEnds={(end) => dispatch({ type: 'ends', ...end })}
          />
        </Row>
      )}
      {moreOpen ? (
        <Row label="Schedule from">
          <ScheduleFrom
            mode={draft.mode}
            dirty={differs('mode')}
            disabled={stopped}
            onChange={(mode) => dispatch({ type: 'mode', mode })}
          />
        </Row>
      ) : (
        <div className="sm:col-start-2">
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            data-every-time-more
            className="text-muted-foreground hover:text-foreground flex items-center gap-0.5 text-xs"
            aria-expanded={false}
          >
            More options
            <ChevronRight className="size-3" aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}

/** A rule the draft can't hold, in words, read-only (see `locked`). */
function LockedRule({ task, stopped }: { task: EveryTimeTask; stopped: boolean }) {
  return (
    <div data-every-time-locked className={cn('space-y-1 text-sm', stopped && 'opacity-50')}>
      <p className="font-medium">{task.rrule ? repeatWords({ ...task, rrule: task.rrule }) : ''}</p>
      <p className="text-muted-foreground text-xs">
        This repeat can&apos;t be edited here. Stop repeating ends it; its schedule is kept exactly
        as it is otherwise.
      </p>
    </div>
  )
}

/** One labelled row of the grid; the label stacks above its control on a phone. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="text-muted-foreground text-xs sm:text-sm">{label}</span>
      <div className="min-w-0">{children}</div>
    </>
  )
}

/** "Repeats on [Target | Deadline]": a radiogroup, arrow keys move it (§12). */
function AnchorSegment({
  anchor,
  dirty,
  disabled,
  onChange,
}: {
  anchor: 'target' | 'deadline'
  dirty: boolean
  disabled: boolean
  onChange: (anchor: 'target' | 'deadline') => void
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  // An arrow key asks for the switch; focus follows only if it happened (a
  // refused switch — the rule's days can't move — leaves focus where it was).
  const wantFocus = useRef(false)
  useEffect(() => {
    if (!wantFocus.current) return
    wantFocus.current = false
    refs.current[anchor === 'target' ? 0 : 1]?.focus()
  }, [anchor])
  const options = [
    { value: 'target' as const, label: TARGET_WORD },
    { value: 'deadline' as const, label: DEADLINE_WORD },
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Repeats on"
      data-every-time-anchor
      className="bg-muted inline-flex rounded-md p-0.5"
      onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
        e.preventDefault()
        wantFocus.current = true
        onChange(anchor === 'target' ? 'deadline' : 'target')
      }}
    >
      {options.map((o, i) => {
        const on = anchor === o.value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-8 rounded px-3 text-sm transition-colors',
              on
                ? cn('bg-background font-semibold shadow-sm', dirty && 'text-blue-500')
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A target-anchored draft's Deadline: "+ Add", then the deadline's time (A2:
 * earlier in the day than the target puts the deadline on the NEXT day, the
 * target "the day before" — the reducer's `addDeadline`).
 */
function AddDeadline({
  autoFocus,
  disabled,
  onPick,
}: {
  autoFocus: boolean
  disabled: boolean
  onPick: (time: string) => void
}) {
  const [picking, setPicking] = useState(false)
  if (picking) {
    return (
      <div className="flex items-center gap-2">
        <TimeSelect
          label="Deadline time"
          value=""
          placeholder="Pick a time"
          autoOpen
          testId="every-time-add-deadline-time"
          onChange={(time) => {
            setPicking(false)
            onPick(time)
          }}
        />
        <button
          type="button"
          onClick={() => setPicking(false)}
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          Cancel
        </button>
      </div>
    )
  }
  return (
    <button
      type="button"
      data-every-time-add-deadline
      autoFocus={autoFocus}
      disabled={disabled}
      onClick={() => setPicking(true)}
      className="h-8 rounded-md border px-3 text-sm font-semibold text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
    >
      + Add
    </button>
  )
}

/**
 * A deadline-anchored draft's Target: "[the day before ▾] at [Evening · 8:30
 * PM ▾]" — the one relative-target control (`RelativeTargetControl`), shared
 * with the one-off target picker. A days-before choice the server would
 * refuse is greyed with its reason (`daysBeforeChoices`, one walk of the
 * rule); on the deadline day itself a period or time later than the deadline
 * is greyed (`targetTimeRefused`).
 */
function RelativeTargetRow({
  draft,
  initial,
  choices,
  slots,
  dispatch,
}: {
  draft: EveryTimeDraft
  initial: EveryTimeDraft
  choices: ReturnType<typeof daysBeforeChoices>
  slots: readonly SlotChoice[]
  dispatch: (action: DraftAction) => void
}) {
  const daysDirty = draft.daysBefore !== initial.daysBefore || initial.anchor !== 'deadline'
  const timeDirty =
    draft.targetTime !== initial.targetTime ||
    (draft.targetSlotId ?? null) !== (initial.targetSlotId ?? null)
  return (
    <Row label={TARGET_WORD}>
      <div data-every-time-relative-target>
        <RelativeTargetControl
          pick={{
            days: draft.daysBefore,
            time: draft.targetTime,
            slot_id: draft.targetSlotId ?? null,
          }}
          daysChoices={choices.map((c) => ({
            days: c.days,
            refused: c.refused ? refusedWords(c.refused) : null,
          }))}
          slots={slots}
          timeRefused={(t) => targetTimeRefused(draft, t)}
          daysDirty={daysDirty}
          timeDirty={timeDirty}
          disabled={draft.stop}
          timeTestId="every-time-target-time"
          onDays={(days) => dispatch({ type: 'daysBefore', days })}
          onTime={(time, slotId) => dispatch({ type: 'targetTime', time, slotId })}
        />
      </div>
    </Row>
  )
}

/**
 * A deadline-anchored draft with NO relative target (the deadlines page,
 * 2026-10-22, L1: no fake targets): "None · on the deadlines page" — each
 * occurrence goes on the page from its lead day — the LEAD STEPPER, beside the
 * deadline ("3 days before"; series-wide, so it lives here, never in this-one
 * mode — Trent, 10-22), "Default" while an override is staged, and "+ Add",
 * which gives it a target at the picker's starting point (the day before, the
 * deadline's time — `scheduleAction` turns `noTarget` off on any target pick).
 * The stepper stops below the rule's wait (the server refuses a lead as long
 * as the gap between deadlines, `leadDaysProblem`).
 */
function NoTargetRow({
  task,
  draft,
  initial,
  ctx,
  dispatch,
}: {
  task: EveryTimeTask
  draft: EveryTimeDraft
  initial: EveryTimeDraft
  ctx: EveryTimeContext
  dispatch: (action: DraftAction) => void
}) {
  const { fallback, max } = useMemo(() => {
    try {
      const rule = {
        rrule: draftRule(draft),
        recurrence_mode: draft.mode,
        anchor_time: draft.deadlineTime,
      }
      const first = task.deadline_at ?? ctx.now.toISOString()
      return {
        // `leadFrom` never puts it later than the day before.
        fallback: Math.max(1, defaultLeadDays(rule, first, ctx.timezone)),
        max: Math.max(1, Math.min(90, ruleWait(rule, first, ctx.timezone) - 1)),
      }
    } catch {
      return { fallback: 1, max: 90 }
    }
  }, [task, draft, ctx])
  // A rule too short for the stored lead resets it (`leadResetForRule`).
  const reset = leadResetForRule(task, draft, ctx)
  const lead = reset ? fallback : Math.min(max, draft.leadDays ?? fallback)
  const dirty = reset || (draft.leadDays ?? null) !== (initial.leadDays ?? null)
  const step = (delta: number) =>
    dispatch({ type: 'leadDays', days: Math.min(max, Math.max(1, lead + delta)) })
  const stepClass =
    'text-muted-foreground hover:text-foreground hover:bg-foreground/5 inline-flex size-8 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-40'
  return (
    <Row label={TARGET_WORD}>
      <div className="flex flex-wrap items-center gap-2" data-every-time-no-target>
        <span className="text-muted-foreground text-sm">
          None · on the deadlines page
          {reset && <LeadResetNote />}
        </span>
        <span
          className="inline-flex items-center"
          role="group"
          aria-label={LEAD_WORD}
          data-every-time-lead
        >
          <button
            type="button"
            className={stepClass}
            disabled={draft.stop || lead <= 1}
            onClick={() => step(-1)}
            aria-label="One day less"
          >
            <Minus className="size-3.5" />
          </button>
          <span
            data-every-time-lead-days={lead}
            aria-live="polite"
            className={cn(
              'min-w-[7.5rem] text-center text-sm',
              dirty && 'font-medium text-blue-500',
            )}
          >
            {leadDaysWords(lead)}
          </span>
          <button
            type="button"
            className={stepClass}
            disabled={draft.stop || lead >= max}
            onClick={() => step(1)}
            aria-label="One day more"
          >
            <Plus className="size-3.5" />
          </button>
          {draft.leadDays != null && !reset && (
            <button
              type="button"
              aria-label="Default lead"
              disabled={draft.stop}
              onClick={() => dispatch({ type: 'leadDays', days: null })}
              className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 ml-1 rounded px-1.5 py-1 text-xs"
            >
              Default
            </button>
          )}
        </span>
        <button
          type="button"
          data-every-time-add-target
          disabled={draft.stop}
          onClick={() => dispatch({ type: 'daysBefore', days: draft.daysBefore || 1 })}
          className="h-8 rounded-md border px-3 text-sm font-semibold text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
        >
          + Add target
        </button>
      </div>
    </Row>
  )
}

/**
 * THE UPCOMING LEAD ROW (2026-10-25, the Upcoming split): on a repeat WITH a
 * target — target-anchored, or deadline-anchored with a relative target —
 * how many days before each occurrence's target it shows in Upcoming's Later
 * section: "Later 3 days before each one · Tomorrow the day before" (a lead
 * of 1: "Tomorrow the day before each one"), and the deadline form's stepper
 * "− 3 days +" with "Default" while an override is staged or stored. The
 * series' lead, so here and never in this-one mode (Trent, 10-22). It stops
 * below the rule's wait (the server refuses a lead as long as the gap
 * between occurrences, `leadDaysProblem`); a daily rule has no row (no
 * Upcoming at all). `upcomingLeadStep` has the numbers.
 */
function UpcomingLeadRow({
  task,
  draft,
  initial,
  ctx,
  dispatch,
}: {
  task: EveryTimeTask
  draft: EveryTimeDraft
  initial: EveryTimeDraft
  ctx: EveryTimeContext
  dispatch: (action: DraftAction) => void
}) {
  const step = useMemo(() => upcomingLeadStep(task, draft, ctx), [task, draft, ctx])
  const reset = useMemo(() => leadResetForRule(task, draft, ctx), [task, draft, ctx])
  // A rule with no Upcoming (daily) that resets a stored lead: the note alone.
  if (!step) return reset ? <LeadResetRow /> : null
  const { lead, max } = step
  const dirty = reset || (draft.leadDays ?? null) !== (initial.leadDays ?? null)
  const move = (delta: number) =>
    dispatch({ type: 'leadDays', days: Math.min(max, Math.max(1, lead + delta)) })
  const stepClass =
    'text-muted-foreground hover:text-foreground hover:bg-foreground/5 inline-flex size-8 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-40'
  return (
    <Row label={LEAD_WORD}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-every-time-upcoming-lead>
        <span
          data-every-time-upcoming-lead-words
          className={cn('text-sm', dirty ? 'font-medium text-blue-500' : 'text-muted-foreground')}
        >
          {upcomingLeadStepWords(lead)}
          {reset && <LeadResetNote />}
        </span>
        <span className="inline-flex items-center" role="group" aria-label={LEAD_WORD}>
          <button
            type="button"
            className={stepClass}
            disabled={draft.stop || lead <= 1}
            onClick={() => move(-1)}
            aria-label="One day less"
          >
            <Minus className="size-3.5" />
          </button>
          <span
            data-every-time-upcoming-lead-days={lead}
            aria-live="polite"
            className={cn(
              'min-w-[3.5rem] text-center text-sm tabular-nums',
              dirty && 'font-medium text-blue-500',
            )}
          >
            {lead} {lead === 1 ? 'day' : 'days'}
          </span>
          <button
            type="button"
            className={stepClass}
            disabled={draft.stop || lead >= max}
            onClick={() => move(1)}
            aria-label="One day more"
          >
            <Plus className="size-3.5" />
          </button>
          {draft.leadDays != null && !reset && (
            <button
              type="button"
              aria-label="Default lead"
              disabled={draft.stop}
              onClick={() => dispatch({ type: 'leadDays', days: null })}
              className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 ml-1 rounded px-1.5 py-1 text-xs"
            >
              Default
            </button>
          )}
        </span>
      </div>
    </Row>
  )
}

/** " · Lead time back to default for the new rule" (`leadResetForRule`), staged blue. */
function LeadResetNote() {
  return (
    <span data-every-time-lead-reset>
      {' · '}
      {LEAD_RESET_FOR_RULE}
    </span>
  )
}

/** The Lead time row with the note alone: the new rule has no Upcoming (daily). */
function LeadResetRow() {
  return (
    <Row label={LEAD_WORD}>
      <span data-every-time-lead-reset className="text-sm font-medium text-blue-500">
        {LEAD_RESET_FOR_RULE}
      </span>
    </Row>
  )
}

/** Why a days-before choice is greyed, in a few words. */
function refusedWords(problem: keyof typeof RELATIVE_TARGET_MESSAGES): string {
  return problem === 'after_deadline' ? 'after the deadline' : 'overlaps the previous one'
}

/** "Schedule from [Fixed schedule | Completion]" (A5, under More options). */
function ScheduleFrom({
  mode,
  dirty,
  disabled,
  onChange,
}: {
  mode: 'from_due' | 'from_completion'
  dirty: boolean
  disabled: boolean
  onChange: (mode: 'from_due' | 'from_completion') => void
}) {
  return (
    <Select
      value={mode}
      disabled={disabled}
      onValueChange={(v) => onChange(v as 'from_due' | 'from_completion')}
    >
      <SelectTrigger
        size="sm"
        aria-label="Schedule from"
        className={cn('min-w-[9rem]', dirty && 'font-medium text-blue-500')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="from_due">Fixed schedule</SelectItem>
        <SelectItem value="from_completion">Completion</SelectItem>
      </SelectContent>
    </Select>
  )
}

/**
 * "Next:" and the next occurrences, ONE PER LINE, each labelled and timed
 * (`nextDateWords`, 2026-10-24):
 *   Next:
 *   Sat Nov 7 · deadline 8:00 AM · target Fri 12:00 PM
 *   Sat Dec 5 · deadline 8:00 AM · target Fri 12:00 PM · last one
 * The last one is marked; a rule that runs out with no last one in view
 * ends with "Ends".
 */
function NextLine({
  next,
  timezone,
  hidden,
}: {
  next: ReturnType<typeof nextDates>
  timezone: string
  hidden: boolean
}) {
  if (hidden) return null
  return (
    <div data-every-time-next aria-live="polite" className="text-muted-foreground text-xs">
      <p className="text-foreground font-semibold">Next:</p>
      {next.dates.length === 0 ? (
        <p>{next.problem ?? ENDS_BEFORE_NEXT}</p>
      ) : (
        <ul>
          {next.dates.map((d) => (
            <li key={d.targetAt ?? d.deadlineAt ?? ''} data-next-date>
              {nextDateWords({ ...d, last: false }, timezone)}
              {d.last && (
                <span data-next-last className="text-foreground font-medium">
                  {' '}
                  · last one
                </span>
              )}
            </li>
          ))}
          {next.ends && !next.dates.some((d) => d.last) && <li>Ends</li>}
        </ul>
      )}
    </div>
  )
}

/**
 * "Stop repeating" (§4.3): staged like everything else — every row greys and
 * the hint says what this one stays as; tapping it again (or Reset) undoes it.
 */
function StopRepeating({
  stopped,
  show,
  onToggle,
}: {
  stopped: boolean
  show: boolean
  onToggle: () => void
}) {
  if (!show) return null
  return (
    <button
      type="button"
      data-every-time-stop
      aria-pressed={stopped}
      onClick={onToggle}
      className={cn(
        'text-xs font-medium',
        stopped ? 'text-blue-500 underline' : 'text-destructive hover:underline',
      )}
    >
      {stopped ? 'Keep repeating' : 'Stop repeating'}
    </button>
  )
}
