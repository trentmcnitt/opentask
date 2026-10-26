'use client'

import { forwardRef, type ComponentProps, type ReactNode, type Ref } from 'react'
import { ChevronRight, Minus, Plus, Repeat } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { DateTimePicker } from '@/components/DateTimePicker'
import {
  DEADLINE_WORD,
  HORIZON_WORD,
  LEAD_WORD,
  NO_TARGET,
  TARGET_WORD,
  targetQuietUntil,
} from '@/lib/task-model-words'
import { isPastDeadline } from '@/lib/task-segments'
import { LEAD_DAYS_MIN } from '@/lib/editor-target-labels'
import { MOVES_WITH_DEADLINE } from '@/lib/relative-target-ui'

/**
 * THE QUICK PANEL'S "THIS ONE" ROWS (2026-10-22, editor plan §3, mock E;
 * PR 4c): the default mode of the task editor — what THIS occurrence is —
 * as labelled rows under the title:
 *
 *   This is the Fri Oct 16 one           (amber; only when it differs, §7)
 *   Target    Fri Nov 6, 6:00 PM · in 16 days
 *   Deadline  Sat Nov 7, 8:00 AM
 *   Lead time On the deadlines page from Tue Nov 3 (4 days before)  − 4 days +
 *   On deck   —
 *   ↻ Repeats — Fridays at 4:00 PM · edit every time ›   (one line: no "since")
 *
 * TRUE LABELS: in this mode the rule's time is never called "Target" — the
 * rule shows only in the link's words. The link is the ONE way into every-
 * time mode (the grey recurrence box and the Repeat icon button are gone,
 * A8); on a one-off it reads "↻ Make it repeat ›". It is disabled while this
 * mode has unsaved edits (one Save is one PATCH — RT-4: a deck plus a
 * schedule change is a 400), with the reason as its title.
 *
 * THE DEADLINE ROW by kind of task:
 *  - a one-off: its picker, as before (Clear removes it);
 *  - a deadline-anchored repeat: this occurrence's deadline — a pick
 *    reschedules THIS occurrence; no Clear (removing it is every-time's
 *    "Repeats on: Target");
 *  - a target-anchored repeat: "None" — a tap opens every-time mode with
 *    "+ Add" focused, the deadline's proper home (this replaces the #313
 *    stopgap that hid the row).
 *
 * THE LEAD TIME ROW ("Lead" until 2026-10-24; the deadlines page, 2026-10-22,
 * plan §2): a deadline task
 * with NO target goes on the deadlines page from its lead day — the row says
 * when ("On the deadlines page from Tue Oct 20 (3 days before)", `leadLine`),
 * adds "· deferred to Thu" when the page's Defer moved THIS instance, and
 * carries the lead override as a stepper (1–90 days before; "Default" puts
 * the table back). A change previews in blue what Save stores (a deadline or
 * lead change re-derives the day and drops a deferral). Only with the task
 * queue on, one task, and no target (staged). The Target row then reads "No
 * target", never an automatic one.
 *
 * ITS UPCOMING FORM (2026-10-25, the Upcoming split): a task with a target
 * (or a deck day) has a lead too — days ahead of the target before it shows
 * in Upcoming's Later section — whatever the task-queue switch says: "Later
 * on Tue Oct 20 (3 days before) · Tomorrow on Thu Oct 22", "Tomorrow on Thu
 * Oct 22 (the day before)", "Not in Upcoming (the target is tomorrow)"
 * (`upcomingLeadLine` / `upcomingLeadWords`). The same stepper and Default.
 *
 * A RELATIVE TARGET (2026-10-24, plan-relative-targets §9) reads "Mon, Nov
 * 2, 8:30 PM in 9 days · the day before, Evening · moves with the deadline"
 * (a custom time: "· the day before · moves with the deadline"); a staged
 * deadline shows the target it gives, in blue. Its picker opens with the
 * "Before the deadline" block (`BeforeDeadlineBlock`).
 *
 * The Target row's DEADLINE-CAP PREVIEW: a staged target after a deadline
 * that is still ahead reads "Sat Nov 7, 8:00 AM · stops at deadline" — the
 * server's own cap (`capAtDeadline`), so the preview is the saved value.
 *
 * EVERY META LINE IS ONE INLINE RUN (2026-10-25): the Target and Deadline
 * values, the On deck words, "Horizon not in effect · Target set: quiet
 * until …" and "↻ Make it repeat › · since Tue" are each plain text flow —
 * fragments are inline spans joined by a space, never flex or grid items. As
 * flex items, a narrow phone column (the value column is ~250px at 375) made
 * each fragment a cell that wrapped on its own, side by side: "Not on / deck"
 * beside "· a deck replaces / target Tue 10 AM". Controls (the On deck
 * button, the Lead time stepper, the repeat link's box) stay boxes of their
 * own; text after them wraps like prose. Guarded by editor-meta-lines.spec.ts.
 */
export function ThisOneFields({
  occurrence,
  target,
  deadline,
  lead = null,
  quietUntil,
  deck,
  link,
  linkRef,
  since,
  timezone,
}: {
  /** "Fri Oct 16" / "Sat Nov 7 (deadline)" (`occurrenceDiffers`), or null. */
  occurrence: string | null
  target: TargetRowProps
  deadline: DeadlineRowProps | null
  /** The deadlines page's lead day and override (`LeadRow`), or null. */
  lead?: LeadRowProps | null
  /** A one-off's own target: the horizon is not in effect until it goes. */
  quietUntil: string | null
  deck: ReactNode | null
  link: RepeatLinkProps | null
  /** Focus returns to the link on "Back to this one" (§12). */
  linkRef?: Ref<HTMLButtonElement>
  since: ReactNode | null
  timezone: string
}) {
  return (
    <div className="mt-1 space-y-1" data-this-one>
      {occurrence && (
        <p
          data-occurrence-differs
          className="text-xs font-medium text-amber-700 dark:text-amber-400"
        >
          This is the {occurrence} one
        </p>
      )}
      <div
        className="grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-1 text-xs"
        data-task-model-fields
      >
        <RowLabel>{TARGET_WORD}</RowLabel>
        <TargetRow {...target} />
        {deadline && (
          <>
            <RowLabel>{DEADLINE_WORD}</RowLabel>
            <DeadlineRow {...deadline} timezone={timezone} />
          </>
        )}
        {lead && (
          <>
            <RowLabel>{LEAD_WORD}</RowLabel>
            <LeadRow {...lead} />
          </>
        )}
        {deck && (
          <>
            <RowLabel>On deck</RowLabel>
            {deck}
          </>
        )}
        {quietUntil && (
          <span
            data-quick-panel-horizon-quiet
            className="text-muted-foreground/60 col-start-2"
            title="A target makes a task quiet until its date. Remove the target to use its horizon."
          >
            <span className="text-muted-foreground/50">{HORIZON_WORD} not in effect ·</span>{' '}
            {targetQuietUntil(DateTime.fromISO(quietUntil).setZone(timezone).toFormat('LLL d'))}
          </span>
        )}
      </div>
      {(link || since) && (
        // One run: the link is an inline box and `SinceAge` brings its own
        // " · since …", so on a narrow screen "since" wraps like a word.
        <p data-quick-panel-repeat-line className="text-xs">
          {link && <RepeatLink ref={linkRef} {...link} />}
          {since}
        </p>
      )}
    </div>
  )
}

function RowLabel({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground/70">{children}</span>
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

type PickerProps = Omit<ComponentProps<typeof DateTimePicker>, 'children'>

export interface TargetRowProps {
  picker: PickerProps
  /** What the row shows (`TargetValue`'s cases). */
  value: TargetValueProps
  /**
   * Words instead of a picker: create mode's staged deadline-anchored repeat,
   * whose target its offsets set ("the day before at 6:00 PM").
   */
  readonlyText?: string | null
}

function TargetRow({ picker, value, readonlyText }: TargetRowProps) {
  if (readonlyText) {
    return (
      <span data-quick-panel-date className="font-medium text-blue-500">
        {readonlyText}
      </span>
    )
  }
  return (
    <DateTimePicker {...picker}>
      <button
        type="button"
        data-quick-panel-date
        aria-label={`${TARGET_WORD}: change`}
        className="min-w-0 cursor-pointer text-left select-text"
      >
        <TargetValue {...value} />
      </button>
    </DateTimePicker>
  )
}

export type TargetValueProps =
  | { kind: 'none'; dirty: boolean }
  | {
      kind: 'date'
      header: string
      relative: string
      dirty: boolean
      past: boolean
      delta: string | null
      /** The deadline-cap preview: the staged target stops at the deadline. */
      capped: string | null
      /**
       * A RELATIVE target (2026-10-24): where it sits before the deadline —
       * "the day before, Evening" — said after the date with "· moves with
       * the deadline".
       */
      relativeWords?: string | null
    }

function TargetValue(props: TargetValueProps) {
  if (props.kind === 'none') {
    return (
      <span
        data-quick-panel-no-target
        className={cn('font-medium', props.dirty ? 'text-blue-500' : 'text-muted-foreground')}
      >
        {NO_TARGET}
      </span>
    )
  }
  if (props.capped) {
    return (
      <span data-target-capped className="font-bold text-blue-500">
        {props.capped} · stops at deadline
      </span>
    )
  }
  // One inline run (see `ThisOneFields`): the spaces join the fragments.
  return (
    <>
      <span className={cn(props.dirty ? 'font-bold text-blue-500' : 'text-foreground')}>
        {props.header}
      </span>{' '}
      <span
        className={cn(
          props.dirty
            ? 'font-bold text-blue-500'
            : props.past
              ? 'text-over-target font-medium'
              : 'text-muted-foreground',
        )}
      >
        {props.relative}
      </span>
      {props.delta && (
        <>
          {' '}
          <span className="font-medium text-blue-500">({props.delta})</span>
        </>
      )}
      {props.relativeWords && ' '}
      {props.relativeWords && (
        <span
          data-target-relative
          className={cn(props.dirty ? 'font-medium text-blue-500' : 'text-muted-foreground')}
        >
          · {props.relativeWords} · {MOVES_WITH_DEADLINE}
        </span>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

export type DeadlineRowProps =
  | {
      kind: 'picker'
      value: string | null
      dirty: boolean
      onChange: (value: string | null) => void
      /** False on a deadline-anchored repeat: its deadline IS the schedule. */
      allowClear: boolean
      /** Where an empty picker opens. */
      emptyAnchor?: string | null
      /** "target the day before at 6:00 PM" (`deadlineRepeatLabel`). */
      repeatLabel?: string | null
    }
  /** A target-anchored repeat: "None", a tap opens every-time with "+ Add" focused. */
  | { kind: 'everyTime'; onOpen: () => void; disabled: boolean; disabledReason: string | null }
  /** Read-only (create mode's staged deadline-anchored repeat: its first deadline). */
  | { kind: 'text'; value: string | null }

function DeadlineRow(props: DeadlineRowProps & { timezone: string }) {
  if (props.kind === 'everyTime') {
    return (
      <button
        type="button"
        data-quick-panel-deadline
        data-deadline-opens-every-time
        onClick={props.onOpen}
        disabled={props.disabled}
        title={props.disabledReason ?? 'A repeating deadline is set for every time'}
        aria-label="Deadline: none — add one for every time"
        className="text-muted-foreground/60 hover:text-foreground inline-flex w-fit cursor-pointer disabled:cursor-not-allowed"
      >
        None
      </button>
    )
  }
  if (props.kind === 'text') {
    return (
      <span data-quick-panel-deadline className="font-medium">
        {props.value ? deadlineWords(props.value, props.timezone) : 'None'}
      </span>
    )
  }
  const when = props.value ? deadlineWords(props.value, props.timezone) : null
  const past = props.value ? isPastDeadline(props.value, new Date()) : false
  return (
    <DateTimePicker
      value={props.value}
      timezone={props.timezone}
      onChange={props.onChange}
      emptyDefault="tomorrow"
      emptyAnchor={props.emptyAnchor ?? null}
      allowClear={props.allowClear}
    >
      <button
        type="button"
        data-quick-panel-deadline
        aria-label={`${DEADLINE_WORD}: change`}
        className="min-w-0 cursor-pointer text-left"
      >
        <span
          className={cn(
            props.dirty
              ? 'font-bold text-blue-500'
              : past
                ? 'text-destructive font-semibold'
                : when
                  ? 'font-medium text-amber-700 dark:text-amber-400'
                  : 'text-muted-foreground/60',
          )}
        >
          {when ? `${when}${past ? ' · past deadline' : ''}` : 'None'}
        </span>
        {when && props.repeatLabel && ' '}
        {when && props.repeatLabel && (
          <span
            data-quick-panel-deadline-repeat
            className={cn(props.dirty ? 'text-blue-500' : 'text-muted-foreground')}
          >
            &middot; {props.repeatLabel}
          </span>
        )}
      </button>
    </DateTimePicker>
  )
}

function deadlineWords(iso: string, timezone: string): string {
  return DateTime.fromISO(iso).setZone(timezone).toFormat('ccc LLL d, h:mm a')
}

// ---------------------------------------------------------------------------
// Lead (the deadlines page)
// ---------------------------------------------------------------------------

export interface LeadRowProps {
  /**
   * Which form: the deadlines page's (a deadline task with no target) or
   * Upcoming's (a task with a target or a deck day, 2026-10-25).
   */
  form: 'deadline' | 'upcoming'
  /** The row's words, worked out by `leadRowFor` (`leadLineWords` / `upcomingLeadWords`). */
  words: string
  /** The deadline form: THIS instance was deferred to (a weekday), or null. */
  deferred: string | null
  /** A staged change produced it (drawn blue): a preview of Save. */
  staged: boolean
  /** The stepper's value, 1–`max` (the EFFECTIVE lead). */
  leadDays: number
  /** An override longer than allowed: "(as early as it can be)", and no "+". */
  clamped: boolean
  /** The user's override, staged or stored; null = the default ("Default" shows only with one). */
  override: number | null
  max: number
  /**
   * The stepper: a one-off's own lead. A REPEAT's lead is series-wide, so
   * this-one mode shows only the words (Trent, 10-22) — the stepper is in
   * every-time mode.
   */
  editable: boolean
  /** Stage an override (1–90), or null for the default table. */
  onLeadDays: (days: number | null) => void
  disabled?: boolean
}

/**
 * "On the deadlines page from Tue Oct 20 (3 days before) · deferred to Thu"
 * or "Later on Tue Oct 20 (3 days before) · Tomorrow on Thu Oct 22", and the
 * stepper "− 3 days +" — the text first, so it wraps under the label on a
 * phone. The stepper's buttons are 28px boxes inside 44px hit targets on a
 * finger (the panel's other small controls' rule). "Default" only while an
 * override is set.
 */
function LeadRow({
  form,
  words,
  deferred,
  staged,
  leadDays,
  clamped,
  override,
  max,
  onLeadDays,
  editable,
  disabled = false,
}: LeadRowProps) {
  const tone = staged ? 'font-medium text-blue-500' : 'text-muted-foreground'
  const step = (delta: number) =>
    onLeadDays(Math.min(max, Math.max(LEAD_DAYS_MIN, leadDays + delta)))
  const stepClass =
    'text-muted-foreground hover:text-foreground hover:bg-foreground/5 inline-flex size-7 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:size-9'
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
      data-quick-panel-lead={form}
    >
      <span className={tone} data-lead-words>
        {words}
        {deferred && (
          <span data-lead-deferred className="text-foreground/70">
            {' '}
            · deferred to {deferred}
          </span>
        )}
      </span>
      {editable && (
        <span className="inline-flex items-center" role="group" aria-label={LEAD_WORD}>
          <button
            type="button"
            className={stepClass}
            disabled={disabled || leadDays <= LEAD_DAYS_MIN}
            onClick={() => step(-1)}
            aria-label="One day less"
          >
            <Minus className="size-3.5" />
          </button>
          <span
            data-lead-days={leadDays}
            aria-live="polite"
            className={cn(
              'min-w-[3.5rem] px-1 text-center tabular-nums',
              staged ? 'font-medium text-blue-500' : 'text-foreground',
            )}
          >
            {leadDays} {leadDays === 1 ? 'day' : 'days'}
            {clamped && (
              <span data-lead-clamped className="text-muted-foreground ml-1 font-normal">
                (as early as it can be)
              </span>
            )}
          </span>
          <button
            type="button"
            className={stepClass}
            disabled={disabled || clamped || leadDays >= max}
            onClick={() => step(1)}
            aria-label="One day more"
          >
            <Plus className="size-3.5" />
          </button>
          {override !== null && (
            <button
              type="button"
              data-lead-default
              aria-label="Default lead"
              disabled={disabled}
              onClick={() => onLeadDays(null)}
              className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 ml-1 rounded px-1.5 py-1 text-xs"
            >
              Default
            </button>
          )}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The way into every-time mode
// ---------------------------------------------------------------------------

export interface RepeatLinkProps {
  /** The rule in words ("Fridays at 4:00 PM"); null = it doesn't repeat ("Make it repeat"). */
  words: string | null
  /** Create mode: the staged rule's link reads "· edit". */
  short?: boolean
  /** A staged (unsaved) rule: drawn blue. */
  dirty?: boolean
  disabled: boolean
  disabledReason: string | null
  onOpen: () => void
}

/**
 * "↻ Repeats — Fridays at 4:00 PM · edit every time ›" / "↻ Make it repeat ›":
 * the text itself is the control (Trent's rule: affordance from the text, a
 * soft background box), a button with an accessible name and
 * no `aria-controls` (the region it opens replaces it, never beside it). Focus comes back here on
 * "Back to this one".
 */
export const RepeatLink = forwardRef<HTMLButtonElement, RepeatLinkProps>(function RepeatLink(
  { words, short = false, dirty = false, disabled, disabledReason, onOpen },
  ref,
) {
  const action = short ? 'edit' : 'edit every time'
  const label = words ? `Repeats ${words} — ${action}` : 'Make it repeat'
  return (
    <button
      ref={ref}
      type="button"
      data-quick-panel-repeat-link
      data-repeats={words ? '' : undefined}
      onClick={onOpen}
      disabled={disabled}
      title={disabledReason ?? undefined}
      aria-label={label}
      className={cn(
        // Out to the left only, so the text lines up with the rows above; a
        // right overhang would pull the "· since" after it into the box.
        '-ml-1.5 inline-flex flex-wrap items-center gap-x-1 rounded px-1.5 py-0.5 text-left align-middle transition-colors',
        'bg-muted/60 hover:bg-accent active:bg-accent disabled:cursor-not-allowed disabled:opacity-60',
        dirty ? 'font-medium text-blue-500' : 'text-muted-foreground',
      )}
    >
      <Repeat className="size-3 shrink-0" aria-hidden />
      {words ? (
        <>
          <span>Repeats — {words}</span>
          {/* "· edit every time ›" is one unit: if a long rule leaves no
              room it moves down whole, never leaving "›" alone on a line. */}
          <span className="inline-flex items-center gap-x-1 whitespace-nowrap">
            <span aria-hidden>·</span>
            <span className="text-foreground/80">{action}</span>
            <ChevronRight className="size-3 shrink-0" aria-hidden />
          </span>
        </>
      ) : (
        <>
          <span>Make it repeat</span>
          <ChevronRight className="size-3 shrink-0" aria-hidden />
        </>
      )}
    </button>
  )
})
