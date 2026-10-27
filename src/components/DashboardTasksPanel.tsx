'use client'

import { useEffect, useRef, useState } from 'react'
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
  EmptySegmentLine,
  SegmentNudge,
  TaskSegmentRow,
  handledRows,
  offersDeferAll,
  segmentCounts,
  segmentDoneColor,
  segmentEmpty,
  segmentKey,
  segmentLabel,
  segmentTitleColor,
  waitingRows,
} from '@/components/TaskSegmentRow'
import { usePanelPager } from '@/hooks/usePanelPager'
import { UpcomingSections } from '@/components/reminders/UpcomingSections'
import { toConsider, type SegmentView, type TaskSegmentActions } from '@/hooks/useTaskSegments'
import { useTaskQueue } from '@/components/PreferencesProvider'
import { onlyWithQueue } from '@/lib/task-segments'
import {
  TASKS_PANEL_PARAM,
  tasksPanelLinkIndex,
  withoutTasksPanelParam,
} from '@/lib/tasks-panel-link'

/**
 * The dashboard's TASKS card, directly beneath the Reminders card (2026-10-11).
 *
 * Trent, after the task segments joined the slots' pager: "i don't like that
 * in the dashboard … now the segments are all in a line. i liked the reminders
 * on top of tasks like it was before." So the task segments got a card of
 * their own again — but one shaped like the Reminders card: its own pager
 * across the segments (with the switch on the deadlines page first, then the
 * task queue's two panels; then Daily, Upcoming, Weekly, Monthly, Quarterly —
 * `SEGMENT_ORDER`), its own strip of
 * bars (the current one taller, as a slot's is; purple while filling, green
 * when finished, the deadlines page teal — `ReminderSlotBar`), the
 * same header (the title, "TASK QUEUE · DAILY", as a slot shows its name; "X of Y"
 * that opens what was considered with put-back, ‹ ›), the same rows, and
 * "Defer all" behind the header tap where a slot has "Considered all".
 *
 * EVERY SEGMENT, EVERY DAY (Trent, 2026-10-24: "always show every queue
 * segment, every day, in fixed positions"). The server sends every kind the
 * web draws (`?fill=1`), so the strip always has the same bars in the same
 * places and the chevrons step through all of them. An EMPTY segment is done
 * from the start of the day: a green bar, "0 of 0 ✓", "Nothing today ✓" on
 * its page (`segmentEmpty`).
 *
 * WHERE IT OPENS: the first segment with anything waiting — an empty one
 * waits for nothing, so it is never where the card opens; finishing one (its
 * last row, or Defer all) moves to the next that waits. It never lands on a
 * finished segment while another waits — Trent's screenshot had the old pager
 * on a weeks segment at "75 of 75 — Nothing left here". When every segment is
 * finished the card collapses to one line ("Tasks · 75 of 75 ✓"), whose count
 * still opens what was considered.
 *
 * Never counted in the nav badge or "Considered all so far"; the Reminders
 * page's headline counts them (task queue on) as its tasks half, apart from
 * the reminders (docs/TASK-MODEL.md § Task segments).
 */
export function DashboardTasksPanel({
  actions,
  timezone,
  hydrated,
}: {
  actions: TaskSegmentActions
  timezone: string
  /** The reminders fetch has landed (`useReminders().hydrated`): the segments are today's. */
  hydrated: boolean
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
      taskSegment: true,
      doneColor: segmentDoneColor(segment.horizon),
      emptyDone: true,
    }
  })
  // No page is a slot: the natural page is the first segment still waiting.
  const pager = usePanelPager(pages, 0, 0)
  const queue = useTaskQueue()
  const sectionRef = useRef<HTMLElement>(null)
  const scrollPending = useRef(false)
  const linkDone = useRef(false)
  // `/?tasks=<kind>` (src/lib/tasks-panel-link.ts): the deadlines nag's tap
  // opens this card on the deadlines page and brings it into view. Read once,
  // after the fetch has landed (`hydrated`, not the module cache's instant
  // paint — the same trap `?reminder=` avoids in RemindersView), straight
  // from window.location, and stripped with a raw history rewrite (never
  // router.replace — see DashboardClient's `?task=`). A kind the card doesn't
  // draw (the deadlines page with the switch off) is consumed and ignored.
  useEffect(() => {
    if (linkDone.current || !hydrated) return
    linkDone.current = true
    const search = window.location.search
    if (!new URLSearchParams(search).has(TASKS_PANEL_PARAM)) return
    const index = tasksPanelLinkIndex(
      search,
      pages.map((p) => p.key),
    )
    if (index !== null && pager) {
      pager.goTo(index)
      scrollPending.current = true
    }
    const rest = withoutTasksPanelParam(search)
    window.history.replaceState(window.history.state, '', window.location.pathname + rest)
  })
  // Bring the card into view, once (the link's page is shown on it; with
  // every page finished the one-line card has no ref and nothing scrolls).
  useEffect(() => {
    if (!scrollPending.current) return
    scrollPending.current = false
    sectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })
  if (!pager) return null
  if (pages.every((p) => p.waiting === 0)) {
    return <TasksDoneLine segments={actions.segments} actions={actions} />
  }
  const { page, index, expanded, setExpanded, showConsidered } = pager
  const { segment } = page
  // A page flip closes a row's peek bubble (the reminder panel's `onJump`):
  // left open, it would come back with its row on the way back.
  const goTo = (next: number) => {
    actions.closePeek()
    pager.goTo(next)
  }
  // A queue panel (or the deadlines page) is only ever sent with the switch
  // on (`useQueueOn`).
  // Before the preferences load (`queue.loaded`) a non-queue page draws no
  // "Considered all" yet, so nothing appears or vanishes when they land.
  const queueOn = onlyWithQueue(segment.horizon) || (queue.loaded && queue.enabled)
  return (
    <section
      ref={sectionRef}
      aria-label="Tasks"
      data-tasks-panel
      data-tasks-page={page.key}
      data-task-segment={segment.horizon}
      className="bg-muted/30 mb-6 overflow-hidden rounded-2xl"
    >
      <SlotPagerHeader
        label={page.label}
        accent={segmentTitleColor(segment.horizon)}
        doneAccent={segmentDoneColor(segment.horizon)}
        time={null}
        considered={page.considered}
        total={page.total}
        expanded={expanded}
        canGoPrev={index > 0}
        canGoNext={index < pages.length - 1}
        onPrev={() => goTo(index - 1)}
        onNext={() => goTo(index + 1)}
        prevLabel="Previous task segment"
        nextLabel="Next task segment"
        sweep={
          expanded && page.waiting > 0 ? (
            <>
              {/* "Considered all" (task queue PR 3, spec rule 9): the slot
                  page's sweep, beside Defer all, with the queue on. The
                  queue's panels have no Defer all (spec rule 8). */}
              {queueOn && toConsider(segment).length > 0 && (
                <PagerSweep
                  kind="consider"
                  ariaLabel={`Mark all in ${page.label} as considered`}
                  onClick={() => void actions.considerAll(segment)}
                />
              )}
              {offersDeferAll(segment.horizon) && (
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
        emptyDone
      />
      <ReminderSlotBar
        items={pages}
        currentIndex={index}
        onJump={goTo}
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
 *
 * Kept with every segment always shown (2026-10-24): with nothing waiting
 * anywhere there is nothing to page to, and the strip would only be a row of
 * green bars. A day with no task rows at all reads "Tasks · 0 of 0 ✓", the
 * count then a plain readout (nothing behind it to open).
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
          disabled={handled === 0}
          aria-expanded={open}
          data-considered-toggle
          aria-label={`${handled} of ${total} considered — show what was considered`}
          className={cn(
            'hover:bg-foreground/5 flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs whitespace-nowrap tabular-nums transition-colors disabled:pointer-events-none',
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
 * put-back, and the slot pages' row cap and "Show more". Upcoming's page
 * (2026-10-25) is two sections, Tomorrow then Later (`UpcomingSections`).
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
  const upcoming = segment.horizon === 'upcoming'
  return (
    <>
      <SegmentNudge segment={segment} className="mx-3" />
      {upcoming ? (
        // Tomorrow, then Later (2026-10-25): the page's row cap spent on
        // Tomorrow first; each section's considered rows under it.
        <UpcomingSections
          segment={segment}
          actions={actions}
          timezone={timezone}
          panel
          cap={expanded ? null : WIDE_CAP}
          narrowCap={expanded ? null : NARROW_CAP}
          showConsidered={showConsidered}
        />
      ) : segmentEmpty(segment) ? (
        <EmptySegmentLine className="px-3 pb-3" doneAccent={segmentDoneColor(segment.horizon)} />
      ) : rows.length === 0 ? (
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
      {!upcoming && showConsidered && handled.length > 0 && (
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
