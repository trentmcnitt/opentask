'use client'

import { useState } from 'react'
import { Forward } from 'lucide-react'
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
  SegmentNudge,
  TaskSegmentRow,
  handledRows,
  segmentCounts,
  segmentColor,
  useSegmentHint,
  segmentKey,
  segmentLabel,
  segmentTitleColor,
  waitingRows,
} from '@/components/TaskSegmentRow'
import type { SegmentView, TaskSegmentActions } from '@/hooks/useTaskSegments'

/**
 * One task segment on /reminders, as a SECTION shaped exactly like a slot's
 * (`ReminderSlotGroup`) — Trent, 2026-10-11: "why isn't tasks segmented like
 * reminders? days, weeks, etc. should be individual segments and behave
 * similarly to the segments for reminders." It replaced the separate card.
 *
 * The same frame, built from the slot's own pieces: the collapsible header
 * (`SlotHeaderRow`: chevron, label, and the segment's hint where a slot shows
 * its time), "X of Y", the hairline, the rows, and "Show N considered" with
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
  const hint = useSegmentHint()
  const color = segmentColor(segment.horizon)
  const label = segmentLabel(segment)
  const waiting = waitingRows(segment)
  const handled = handledRows(segment)
  const { handled: handledCount, total } = segmentCounts(segment)
  const headerRow = (
    <SlotHeaderRow
      label={label}
      time={hint(segment)}
      count={waiting.length}
      considered={handledCount}
      open={open}
      started
      accent={segmentTitleColor(segment.horizon)}
      stackTime
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
          // py-1.5 below `sm`: the hint's own line (stackTime) still fits the
          // 44px row. A slot's header is one line, py-2.
          className="hover:text-foreground flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 text-left transition-colors sm:py-2"
        >
          {headerRow}
        </button>
        {open && waiting.length > 0 && (
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

      <SlotHairline label={label} considered={handledCount} total={total} color={color} />

      {open && (
        <>
          <SegmentNudge segment={segment} className="mx-3" />
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
 * Every task segment with a row today, AFTER the slots (Trent, 10-11: "Tasks
 * should go underneath Reminders"), in screen order (days, upcoming,
 * weeks, months, eventually), with the slots' spacing. Open/folded comes from the slots' own
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
