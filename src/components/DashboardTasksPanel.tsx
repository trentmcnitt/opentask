'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ReminderSlotBar } from '@/components/ReminderSlotBar'
import {
  NARROW_CAP,
  PagerSweep,
  RowCountToggle,
  SlotPagerHeader,
  WIDE_CAP,
} from '@/components/reminders/PanelPagerParts'
import {
  ConsideredSegmentRow,
  SegmentNudge,
  TaskSegmentRow,
  handledRows,
  segmentColor,
  segmentCounts,
  segmentKey,
  segmentLabel,
  segmentTitleColor,
  waitingRows,
} from '@/components/TaskSegmentRow'
import { usePanelPager } from '@/hooks/usePanelPager'
import type { SegmentView, TaskSegmentActions } from '@/hooks/useTaskSegments'
import { useTaskQueue } from '@/components/PreferencesProvider'
import { isQueueKind } from '@/lib/task-segments'

/**
 * The dashboard's TASKS card, directly beneath the Reminders card (2026-10-11).
 *
 * Trent, after the task segments joined the slots' pager: "i don't like that
 * in the dashboard … now the segments are all in a line. i liked the reminders
 * on top of tasks like it was before." So the task segments got a card of
 * their own again — but one shaped like the Reminders card: its own pager
 * across today's segments (the task queue's two panels first, with the
 * switch on, then Daily, Upcoming, Weekly, Monthly, Quarterly), its own strip of
 * teal bars (the current one taller, as a slot's is; green when finished), the
 * same header (the one-word title, "DAILY", as a slot shows its name; "X of Y"
 * that opens what was considered with put-back, ‹ ›), the same rows, and
 * "Defer all" behind the header tap where a slot has "Considered all".
 *
 * WHERE IT OPENS: the first segment with anything waiting; finishing one (its
 * last row, or Defer all) moves to the next that waits. It never lands on a
 * finished segment while another waits — Trent's screenshot had the old pager
 * on a weeks segment at "75 of 75 — Nothing left here". When every segment is
 * finished the card collapses to one line ("Tasks · 75 of 75 ✓"), whose count
 * still opens what was considered.
 *
 * Only on a day with task segments. Never counted in the reminders headline,
 * the nav badge or "Considered all so far" (docs/TASK-MODEL.md § Task segments).
 */
export function DashboardTasksPanel({
  actions,
  timezone,
}: {
  actions: TaskSegmentActions
  timezone: string
}) {
  const pages = actions.segments.map((segment) => {
    const { handled, total } = segmentCounts(segment)
    return {
      key: segmentKey(segment),
      label: segmentLabel(segment),
      segment,
      waiting: segment.waiting,
      considered: handled,
      total,
      started: true,
      color: segmentColor(segment.horizon),
    }
  })
  // No page is a slot: the natural page is the first segment still waiting.
  const pager = usePanelPager(pages, 0, 0)
  const queue = useTaskQueue()
  if (!pager) return null
  if (pages.every((p) => p.waiting === 0)) {
    return <TasksDoneLine segments={actions.segments} actions={actions} />
  }
  const { page, index, expanded, setExpanded, showConsidered } = pager
  const { segment } = page
  // A queue panel is only ever sent with the switch on (`useQueueOn`).
  // Before the preferences load (`queue.loaded`) a non-queue page draws no
  // "Considered all" yet, so nothing appears or vanishes when they land.
  const queueOn = isQueueKind(segment.horizon) || (queue.loaded && queue.enabled)
  return (
    <section
      aria-label="Tasks"
      data-tasks-panel
      data-tasks-page={page.key}
      data-task-segment={segment.horizon}
      className="bg-muted/30 mb-6 overflow-hidden rounded-2xl"
    >
      <SlotPagerHeader
        label={page.label}
        accent={segmentTitleColor(segment.horizon)}
        time={null}
        considered={page.considered}
        total={page.total}
        expanded={expanded}
        canGoPrev={index > 0}
        canGoNext={index < pages.length - 1}
        onPrev={() => pager.goTo(index - 1)}
        onNext={() => pager.goTo(index + 1)}
        prevLabel="Previous task segment"
        nextLabel="Next task segment"
        sweep={
          expanded && page.waiting > 0 ? (
            <>
              {/* "Considered all" (task queue PR 3, spec rule 9): the slot
                  page's sweep, beside Defer all, with the queue on. The
                  queue's panels have no Defer all (spec rule 8). */}
              {queueOn && (
                <PagerSweep
                  kind="consider"
                  ariaLabel={`Mark all in ${page.label} as considered`}
                  onClick={() => void actions.considerAll(segment)}
                />
              )}
              {!isQueueKind(segment.horizon) && (
                <PagerSweep
                  kind="defer"
                  ariaLabel={`Defer all ${page.waiting} in ${page.label}`}
                  onClick={() => void actions.deferAll(segment)}
                />
              )}
            </>
          ) : null
        }
        onToggleExpanded={() => setExpanded(!expanded)}
        showConsidered={showConsidered}
        onToggleConsidered={pager.toggleConsidered}
      />
      <ReminderSlotBar
        items={pages}
        currentIndex={index}
        onJump={pager.goTo}
        ariaLabel="Today's task segments"
      />
      <TaskPageBody
        segment={segment}
        actions={actions}
        timezone={timezone}
        expanded={expanded}
        showConsidered={showConsidered}
        onToggleExpanded={() => setExpanded(!expanded)}
      />
    </section>
  )
}

/**
 * Every segment finished: one line, "Tasks · 75 of 75 ✓", rather than a page
 * that says "Nothing left here". Its count opens everything considered or
 * deferred today, each with its put-back — the pager's own "X of Y" tap.
 */
function TasksDoneLine({
  segments,
  actions,
}: {
  segments: SegmentView[]
  actions: TaskSegmentActions
}) {
  const [open, setOpen] = useState(false)
  const handled = segments.reduce((n, s) => n + segmentCounts(s).handled, 0)
  const total = segments.reduce((n, s) => n + segmentCounts(s).total, 0)
  return (
    <section
      aria-label="Tasks"
      data-tasks-panel
      data-tasks-done
      className="bg-muted/30 mb-6 overflow-hidden rounded-2xl"
    >
      <div className="flex min-h-11 items-center gap-1.5 px-3 py-1.5">
        <span className="text-muted-foreground min-w-0 flex-1 text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
          Tasks
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-considered-toggle
          aria-label={`${handled} of ${total} considered — show what was considered`}
          className={cn(
            'hover:bg-foreground/5 flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs whitespace-nowrap tabular-nums transition-colors',
            open && 'bg-foreground/5',
          )}
        >
          <span className={open ? 'text-foreground' : 'text-muted-foreground'}>
            {handled} of {total}
          </span>
          <Check
            className="size-3.5 text-green-700 dark:text-green-400"
            strokeWidth={2.5}
            aria-hidden="true"
          />
        </button>
      </div>
      {open && (
        <ul className="space-y-0.5 px-2 pb-1" aria-label="Considered tasks">
          {segments.flatMap((s) =>
            handledRows(s).map((row) => (
              <ConsideredSegmentRow
                key={row.task.id}
                row={row}
                panel
                onPutBack={(task) => void actions.restore(task)}
              />
            )),
          )}
        </ul>
      )}
    </section>
  )
}

/**
 * A task segment's page: the same body as a slot's, with the segment's rows
 * (circle = consider, Today, horizon chip, done square — the panel row
 * geometry), its considered and deferred rows behind the count with their
 * put-back, and the slot pages' row cap and "Show more".
 */
function TaskPageBody({
  segment,
  actions,
  timezone,
  expanded,
  showConsidered,
  onToggleExpanded,
}: {
  segment: SegmentView
  actions: TaskSegmentActions
  timezone: string
  expanded: boolean
  showConsidered: boolean
  onToggleExpanded: () => void
}) {
  const label = segmentLabel(segment)
  const rows = waitingRows(segment)
  const handled = handledRows(segment)
  const visible = expanded ? rows : rows.slice(0, WIDE_CAP)
  return (
    <>
      <SegmentNudge segment={segment} className="mx-3" />
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-3 pb-3 text-sm">Nothing left here</p>
      ) : (
        <ul className="space-y-0.5 px-2 pb-1" aria-label={label}>
          {visible.map((row, i) => (
            <TaskSegmentRow
              key={row.task.id}
              row={row}
              actions={actions}
              timezone={timezone}
              panel
              segmentHorizon={segment.horizon}
              hiddenWhenNarrow={!expanded && i >= NARROW_CAP}
            />
          ))}
        </ul>
      )}
      {showConsidered && handled.length > 0 && (
        <ul className="space-y-0.5 px-2 pb-1" aria-label={`Considered in ${label}`}>
          {handled.map((row) => (
            <ConsideredSegmentRow
              key={row.task.id}
              row={row}
              panel
              onPutBack={(task) => void actions.restore(task)}
            />
          ))}
        </ul>
      )}
      {rows.length - NARROW_CAP > 0 && (
        <RowCountToggle
          expanded={expanded}
          hiddenWhenNarrow={rows.length - NARROW_CAP}
          hiddenWhenWide={rows.length - WIDE_CAP}
          onToggle={onToggleExpanded}
        />
      )}
    </>
  )
}
