'use client'

import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChevronLeft, ChevronRight, Repeat } from 'lucide-react'
import { DateTime } from 'luxon'
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
  nextDateWords,
  nextDates,
  targetTimeRefused,
  thisOneHint,
  type DraftAction,
  type EveryTimeContext,
  type EveryTimeDraft,
  type EveryTimeTask,
} from '@/lib/every-time'
import { relativeDaysWords, repeatWords } from '@/lib/editor-target-labels'
import { RELATIVE_TARGET_MESSAGES, repeatEndOf } from '@/lib/task-segments'
import { DEADLINE_WORD, TARGET_WORD } from '@/lib/task-model-words'
import { HowOftenField } from '@/components/quick-panel/HowOftenField'
import { EndsField } from '@/components/quick-panel/EndsField'
import { TimeSelect } from '@/components/quick-panel/TimeSelect'

/** The id the this-one link points `aria-controls` at. */
export const EVERY_TIME_REGION_ID = 'quick-panel-every-time'

export type EveryTimeVariant = 'single' | 'create' | 'bulk'

/**
 * THE QUICK PANEL'S "EVERY TIME" MODE (2026-10-22, editor plan §4, mock E;
 * PR 4c). The panel edits a repeating task in two modes: THIS ONE (the
 * default — this occurrence's target, deadline, deck) and EVERY TIME (the
 * schedule). This is the second: a framed card with a teal banner
 * ("EDITING EVERY TIME ‹ Back to this one" — teal is the MODE, blue stays
 * "unsaved"), then
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
      className="border-every-time rounded-lg border-2"
    >
      <Banner headingId={headingId} headingRef={headingRef} onBack={onBack} />
      <div className="space-y-3 p-3">
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
    <div className="bg-every-time text-every-time-foreground sticky top-0 z-10 flex items-center justify-between gap-2 rounded-t-[0.3rem] pl-3">
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
}: {
  variant: EveryTimeVariant
  task: EveryTimeTask
  initial: EveryTimeDraft
  draft: EveryTimeDraft
  dispatch: (action: DraftAction) => void
  ctx: EveryTimeContext
  focusDeadline: boolean
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
  const today = DateTime.fromJSDate(ctx.now).setZone(ctx.timezone).toISODate()!
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
        <RelativeTargetRow draft={draft} initial={initial} choices={choices} dispatch={dispatch} />
      ) : variant === 'bulk' ? null : (
        <Row label={DEADLINE_WORD}>
          <AddDeadline
            autoFocus={focusDeadline}
            disabled={stopped}
            onPick={(time) => dispatch({ type: 'addDeadline', time, ctx })}
          />
        </Row>
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
 * A deadline-anchored draft's Target: "[the day before ▾] at [6:00 PM ▾]".
 * A days-before choice the server would refuse is greyed with its reason
 * (`daysBeforeChoices`, one walk of the rule); on the deadline day itself a
 * time later than the deadline is greyed (`targetTimeRefused`).
 */
function RelativeTargetRow({
  draft,
  initial,
  choices,
  dispatch,
}: {
  draft: EveryTimeDraft
  initial: EveryTimeDraft
  choices: ReturnType<typeof daysBeforeChoices>
  dispatch: (action: DraftAction) => void
}) {
  const all = choices.some((c) => c.days === draft.daysBefore)
    ? choices
    : [...choices, { days: draft.daysBefore, refused: null }]
  const daysDirty = draft.daysBefore !== initial.daysBefore || initial.anchor !== 'deadline'
  const timeDirty = draft.targetTime !== initial.targetTime
  return (
    <Row label={TARGET_WORD}>
      <div className="flex flex-wrap items-center gap-2" data-every-time-relative-target>
        <Select
          value={String(draft.daysBefore)}
          disabled={draft.stop}
          onValueChange={(v) => dispatch({ type: 'daysBefore', days: parseInt(v) })}
        >
          <SelectTrigger
            size="sm"
            aria-label="Days before the deadline"
            className={cn('min-w-[8rem]', daysDirty && 'font-medium text-blue-500')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {all.map((c) => (
              <SelectItem
                key={c.days}
                value={String(c.days)}
                disabled={c.refused !== null && c.days !== draft.daysBefore}
                aria-disabled={c.refused !== null || undefined}
                data-refused={c.refused ?? undefined}
              >
                {relativeDaysWords(c.days)}
                {c.refused && (
                  <span className="text-muted-foreground ml-1 text-xs">
                    — {refusedWords(c.refused)}
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground text-sm">at</span>
        <TimeSelect
          label="Target time"
          value={draft.targetTime}
          dirty={timeDirty}
          disabled={draft.stop}
          testId="every-time-target-time"
          refused={(t) => targetTimeRefused(draft, t)}
          refusedReason="after the deadline"
          onChange={(time) => dispatch({ type: 'targetTime', time })}
        />
      </div>
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

/** "Next: Fri Nov 6 → Sat Nov 7 · Fri Dec 4 → Sat Dec 5 · …", the last marked. */
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
    <p data-every-time-next aria-live="polite" className="text-muted-foreground text-xs">
      <span className="text-foreground font-semibold">Next:</span>{' '}
      {next.dates.length === 0 ? (
        (next.problem ?? ENDS_BEFORE_NEXT)
      ) : (
        <>
          {next.dates.map((d, i) => (
            <span key={d.targetAt ?? d.deadlineAt ?? ''} data-next-date>
              {i > 0 && <span aria-hidden> · </span>}
              {nextDateWords({ ...d, last: false }, timezone)}
              {d.last && (
                <span data-next-last className="text-foreground font-medium">
                  {' '}
                  · last one
                </span>
              )}
            </span>
          ))}
          {next.ends && !next.dates.some((d) => d.last) && <span> · ends</span>}
        </>
      )}
    </p>
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
