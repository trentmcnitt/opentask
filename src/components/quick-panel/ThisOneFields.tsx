'use client'

import { forwardRef, type ComponentProps, type ReactNode, type Ref } from 'react'
import { ChevronRight, Repeat } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { DateTimePicker } from '@/components/DateTimePicker'
import { AutoTargetText } from '@/components/quick-panel/AutoTargetText'
import { DEADLINE_WORD, HORIZON_WORD, TARGET_WORD, targetQuietUntil } from '@/lib/task-model-words'
import { isPastDeadline } from '@/lib/task-segments'
import type { AutoTargetLabel } from '@/lib/editor-target-labels'

/**
 * THE QUICK PANEL'S "THIS ONE" ROWS (2026-10-22, editor plan §3, mock E;
 * PR 4c): the default mode of the task editor — what THIS occurrence is —
 * as labelled rows under the title:
 *
 *   This is the Fri Oct 16 one           (amber; only when it differs, §7)
 *   Target    Fri Nov 6, 6:00 PM · in 16 days
 *   Deadline  Sat Nov 7, 8:00 AM
 *   On deck   —
 *   ↻ Repeats — Fridays at 4:00 PM · edit every time ›     · since …
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
 * The Target row's DEADLINE-CAP PREVIEW: a staged target after a deadline
 * that is still ahead reads "Sat Nov 7, 8:00 AM · stops at deadline" — the
 * server's own cap (`capAtDeadline`), so the preview is the saved value.
 */
export function ThisOneFields({
  occurrence,
  target,
  deadline,
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
        {deck && (
          <>
            <RowLabel>On deck</RowLabel>
            {deck}
          </>
        )}
        {quietUntil && (
          <span
            data-quick-panel-horizon-quiet
            className="text-muted-foreground/60 col-start-2 inline-flex items-center gap-1"
            title="A target makes a task quiet until its date. Remove the target to use its horizon."
          >
            <span className="text-muted-foreground/50">{HORIZON_WORD} not in effect ·</span>
            {targetQuietUntil(DateTime.fromISO(quietUntil).setZone(timezone).toFormat('LLL d'))}
          </span>
        )}
      </div>
      {(link || since) && (
        <p className="flex flex-wrap items-center gap-x-1 text-xs">
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
        className="inline-flex min-w-0 cursor-pointer flex-wrap items-center gap-x-1 text-left select-text"
      >
        <TargetValue {...value} />
      </button>
    </DateTimePicker>
  )
}

export type TargetValueProps =
  | { kind: 'auto'; label: AutoTargetLabel; dirty: boolean; timezone: string }
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
    }

function TargetValue(props: TargetValueProps) {
  if (props.kind === 'auto') {
    return <AutoTargetText label={props.label} timezone={props.timezone} dirty={props.dirty} />
  }
  if (props.kind === 'none') {
    return (
      <span className={cn('font-medium', props.dirty ? 'text-blue-500' : 'text-muted-foreground')}>
        No target
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
  return (
    <>
      <span className={cn(props.dirty ? 'font-bold text-blue-500' : 'text-foreground')}>
        {props.header}
      </span>
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
      {props.delta && <span className="font-medium text-blue-500">({props.delta})</span>}
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
        className="inline-flex min-w-0 cursor-pointer flex-wrap items-center gap-x-1 text-left"
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
        '-mx-1.5 inline-flex flex-wrap items-center gap-x-1 rounded px-1.5 py-0.5 text-left transition-colors',
        'bg-muted/60 hover:bg-accent active:bg-accent disabled:cursor-not-allowed disabled:opacity-60',
        dirty ? 'font-medium text-blue-500' : 'text-muted-foreground',
      )}
    >
      <Repeat className="size-3 shrink-0" aria-hidden />
      {words ? (
        <>
          <span>Repeats — {words}</span>
          <span aria-hidden>·</span>
          <span className="text-foreground/80">{action}</span>
        </>
      ) : (
        <span>Make it repeat</span>
      )}
      <ChevronRight className="size-3 shrink-0" aria-hidden />
    </button>
  )
})
