'use client'

import { useState } from 'react'
import { CheckCheck, Forward } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  SLOT_FOOTER_TOGGLE_CLASS,
  SLOT_SWEEP_CLASS,
  SlotHairline,
  SlotHeaderRow,
  useSlotScroll,
} from '@/components/reminders/ReminderSlotGroup'
import {
  ConsideredSegmentRow,
  EmptySegmentLine,
  SegmentNudge,
  TaskSegmentRow,
  handledRows,
  offersDeferAll,
  segmentCounts,
  segmentDoneColor,
  segmentDoneTextColor,
  segmentEmpty,
  segmentKey,
  segmentLabel,
  segmentTitleColor,
  useQueueOn,
  waitingRows,
} from '@/components/TaskSegmentRow'
import { toConsider, type SegmentView, type TaskSegmentActions } from '@/hooks/useTaskSegments'
import { UpcomingSections } from '@/components/reminders/UpcomingSections'

/**
 * One task segment on /reminders, as a SECTION shaped exactly like a slot's
 * (`ReminderSlotGroup`) — Trent, 2026-10-11: "why isn't tasks segmented like
 * reminders? days, weeks, etc. should be individual segments and behave
 * similarly to the segments for reminders." It replaced the separate card.
 *
 * The same frame, built from the slot's own pieces: the collapsible header
 * (`SlotHeaderRow`: chevron and the segment's title — one word, with no time
 * or hint after it, 2026-10-20), "X of Y", the hairline, the rows, and "Show N considered" with
 * put-back. Where a slot has "Considered all" a segment has "Defer all" (no
 * confirm: one Undo reverses it, and it only ever takes rows off TODAY's list).
 *
 * DELIBERATE DIFFERENCES from a slot:
 * - No `data-slot-group` / `data-slot-key`: a segment is not a slot, and code
 *   and tests that walk the slots (the day bar, `goToSlot`) must not find it.
 * - Never dimmed: a segment has no start time — it is today's from the first
 *   minute — so it is always "started", and never says "N later".
 * - No row cap: a slot still ahead previews 5 rows because it is not work in
 *   hand yet; a segment always is, like a started slot, which shows everything.
 * - Rows are not selectable (no selection bar for tasks here); the circle and
 *   a tap on the row consider, as before.
 * - EMPTY IS DONE (Trent, 2026-10-24: "always show every queue segment, every
 *   day, in fixed positions"): a segment with no rows today is still here, in
 *   its place, finished from the start of the day — "0 of 0 ✓", a green
 *   hairline, and "Nothing today ✓" where its rows would be. An empty slot
 *   is never drawn at all.
 * - UPCOMING (2026-10-25) has two sub-lists under its one header, Tomorrow
 *   then Later (`UpcomingSections`); the header's count, Considered all and
 *   Defer all stay the segment's.
 */
export function TaskSegmentGroup({
  segment,
  actions,
  timezone,
  open,
  onToggle,
  scrollRequest,
  onScrollServed,
}: {
  segment: SegmentView
  actions: TaskSegmentActions
  timezone: string
  open: boolean
  onToggle: () => void
  /** A pending tap on this segment's bar in the headline's day bar
   *  (`goToSlot`): scrolls the section into view, as for a slot. */
  scrollRequest?: number
  onScrollServed?: (seq: number) => void
}) {
  const sectionRef = useSlotScroll<HTMLElement>(scrollRequest, onScrollServed)
  const queueOn = useQueueOn(segment.horizon)
  // Finished in its own colour, not green (the deadlines page only): the
  // fill teal for the hairline and the ✓ glyphs; the count's numbers take
  // the text teal (`segmentDoneTextColor`).
  const doneColor = segmentDoneColor(segment.horizon)
  const label = segmentLabel(segment)
  const waiting = waitingRows(segment)
  const handled = handledRows(segment)
  const { handled: handledCount, total } = segmentCounts(segment)
  // What "Considered all" would still change (not a seen safety-net row).
  const considerable = toConsider(segment).length
  const empty = segmentEmpty(segment)
  const headerRow = (
    <SlotHeaderRow
      label={label}
      time={null}
      count={waiting.length}
      considered={handledCount}
      open={open}
      started
      accent={segmentTitleColor(segment.horizon)}
      doneAccent={segmentDoneTextColor(segment.horizon)}
      doneColor={doneColor}
      emptyDone
    />
  )
  return (
    <section
      ref={sectionRef}
      aria-label={label}
      data-task-segment={segment.horizon}
      // The slot section's own frame (`ReminderSlotGroup`), so the column
      // reads as one list of segments.
      className={cn('bg-muted/30 rounded-2xl pb-1 transition-colors', open && 'pb-2')}
      // Clears the sticky top bar when the day bar scrolls it to the top.
      style={{ scrollMarginTop: '4.5rem' }}
    >
      <div className="flex min-h-11 items-center gap-2 px-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="hover:text-foreground flex min-w-0 flex-1 items-center gap-2 rounded-lg py-2 text-left transition-colors"
        >
          {headerRow}
        </button>
        {/* "Considered all" (task queue PR 3, spec rule 9): the slot's own
            sweep, in the slot's place and style, on every task segment while
            it has rows waiting — one consider call, one Undo, no confirm (Defer
            all beside it has none; the toast's Undo is the recovery). Only
            with the task queue on. The queue's panels have no Defer all: their
            gestures are consider, Today and done (spec rule 8). */}
        {open && queueOn && considerable > 0 && (
          <button
            type="button"
            data-segment-consider-all
            onClick={() => void actions.considerAll(segment)}
            aria-label={`Mark all ${considerable} in ${label} as considered`}
            className={SLOT_SWEEP_CLASS}
          >
            <CheckCheck className="size-3.5" strokeWidth={2.5} />
            <span className="hidden sm:inline">Considered all</span>
          </button>
        )}
        {open && waiting.length > 0 && offersDeferAll(segment.horizon) && (
          <button
            type="button"
            onClick={() => void actions.deferAll(segment)}
            aria-label={`Defer all ${waiting.length} in ${label}`}
            title="Take the rest off today's list; they come back tomorrow"
            className={SLOT_SWEEP_CLASS}
          >
            <Forward className="size-3.5" strokeWidth={2.5} />
            <span className="hidden sm:inline">Defer all</span>
          </button>
        )}
      </div>

      <SlotHairline
        label={label}
        considered={handledCount}
        total={total}
        doneColor={doneColor}
        // Empty is done: a full green line (`doneColor`'s), not an empty track.
        fraction={empty ? 1 : undefined}
      />

      {open && segment.horizon === 'upcoming' && (
        <>
          <SegmentNudge segment={segment} className="mx-3" />
          {/* Tomorrow, then Later (2026-10-25): each with its own count,
              "Nothing today ✓" and "Show N considered". */}
          <UpcomingSections segment={segment} actions={actions} timezone={timezone} panel={false} />
        </>
      )}
      {open && segment.horizon !== 'upcoming' && (
        <>
          <SegmentNudge segment={segment} className="mx-3" />
          {empty && <EmptySegmentLine className="px-3 pb-1" doneAccent={doneColor} />}
          {waiting.length > 0 && (
            <ul className="space-y-0.5 px-1" aria-label={label}>
              {waiting.map((row) => (
                <TaskSegmentRow
                  key={row.task.id}
                  row={row}
                  actions={actions}
                  timezone={timezone}
                  panel={false}
                  segmentHorizon={segment.horizon}
                />
              ))}
            </ul>
          )}
          <SegmentConsideredDisclosure
            segment={segment}
            rows={handled}
            onPutBack={(task) => void actions.restore(task)}
          />
        </>
      )}
    </section>
  )
}

/** The slot's `ConsideredDisclosure`, for a segment's considered and deferred rows. */
function SegmentConsideredDisclosure({
  segment,
  rows,
  onPutBack,
}: {
  segment: SegmentView
  rows: ReturnType<typeof handledRows>
  onPutBack: (task: SegmentView['rows'][number]['task']) => void
}) {
  const [shown, setShown] = useState(false)
  if (rows.length === 0) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-expanded={shown}
        data-segment-considered-toggle
        className={SLOT_FOOTER_TOGGLE_CLASS}
      >
        {shown ? 'Hide' : 'Show'} {rows.length} considered
      </button>
      {shown && (
        <ul className="space-y-0.5 px-1" aria-label={`Considered in ${segmentLabel(segment)}`}>
          {rows.map((row) => (
            <ConsideredSegmentRow key={row.task.id} row={row} panel={false} onPutBack={onPutBack} />
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * Every task segment, AFTER the slots (Trent, 10-11: "Tasks should go
 * underneath Reminders"), in screen order (`SEGMENT_ORDER`: with the switch on
 * the deadlines page, then the task queue's two panels; days, upcoming,
 * weeks, months, eventually), with the slots' spacing. Every one, every day
 * (2026-10-24, the server's `?fill=1`): an empty one reads "Nothing today ✓". Open/folded comes from the slots' own
 * `useSlotDisclosure`, under a "tasks:<horizon>" key that is never a slot id.
 */
export function TaskSegmentSections({
  actions,
  timezone,
  isOpen,
  onToggle,
  scroll,
  onScrollServed,
}: {
  actions: TaskSegmentActions
  timezone: string
  isOpen: (key: string) => boolean
  onToggle: (key: string) => void
  /** `goToSlot`'s pending request, when it is for a task segment. */
  scroll?: { key: string; seq: number } | null
  onScrollServed?: (seq: number) => void
}) {
  if (actions.segments.length === 0) return null
  return (
    <div className="mt-3 space-y-3" data-task-segments>
      {actions.segments.map((segment) => (
        <TaskSegmentGroup
          key={segment.horizon}
          segment={segment}
          actions={actions}
          timezone={timezone}
          open={isOpen(segmentKey(segment))}
          onToggle={() => onToggle(segmentKey(segment))}
          scrollRequest={scroll?.key === segmentKey(segment) ? scroll.seq : undefined}
          onScrollServed={onScrollServed}
        />
      ))}
    </div>
  )
}
