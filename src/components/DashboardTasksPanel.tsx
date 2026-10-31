'use client'

import { Fragment, useEffect, useRef } from 'react'
import { ReminderSlotBar, stripMarkFor } from '@/components/ReminderSlotBar'
import {
  NARROW_CAP,
  PagerSweep,
  RowCountToggle,
  SlotPagerHeader,
  WIDE_CAP,
} from '@/components/reminders/PanelPagerParts'
import {
  AgedGroupHeading,
  PulledSectionHeading,
  agedGroupBefore,
  pulledSectionBefore,
  rowKind,
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
import {
  QueueSelectContext,
  QueueSelectEnterContext,
  QueueSelectToggle,
  useQueueSelectMode,
} from '@/components/QueueSelect'
import { toConsider, type SegmentView, type TaskSegmentActions } from '@/hooks/useTaskSegments'
import { TASK_QUEUE_TITLE } from '@/lib/task-model-words'
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
 * task queue's two panels; then Days, Heads up, Weeks, Months, Eventually —
 * `SEGMENT_ORDER`), its own strip of
 * bars (the current one taller, as a slot's is; purple while filling, green
 * when finished, the deadlines page teal — `ReminderSlotBar`), the
 * same header (the title, "TASK QUEUE · DAILY", as a slot shows its name; "X of Y"
 * that opens what was considered with put-back, ‹ ›), the same rows, and
 * "Defer all" behind the header tap where a slot has "Considered all".
 *
 * ONLY THE SEGMENTS WITH ROWS (Trent, 2026-10-30, reversing 10-24's "every
 * segment, every day"): a segment with no rows today is not drawn — no bar,
 * no page (`useTaskSegments`). The order stays fixed; only presence changes.
 * A segment finished today keeps its rows and stays, green, until the
 * rollover. With only one segment the strip still shows its one word.
 *
 * WHERE IT OPENS: the first segment with anything waiting — an empty one
 * waits for nothing, so it is never where the card opens; finishing one (its
 * last row, or Defer all) moves to the next that waits. It never lands on a
 * finished segment while another waits — Trent's screenshot had the old pager
 * on a weeks segment at "75 of 75 — Nothing left here".
 *
 * EVERY SEGMENT FINISHED: the card stays as it is, like the Reminders card
 * above it (Trent, 2026-10-30: "I was disappointed that it completely
 * collapsed, unlike the reminders one above, which is more satisfying") —
 * "TASK QUEUE" with the page's count in green and ✓, the strip all green,
 * "Nothing left here", and every finished segment still a page to flip to,
 * its considered rows behind the count. It used to fold to one line,
 * "Tasks · 75 of 75 ✓".
 *
 * Never counted in the nav badge or "Considered all so far"; the Reminders
 * page's headline counts them (task queue on) as its tasks half, apart from
 * the reminders (docs/TASK-MODEL.md § Task segments).
 */
export function DashboardTasksPanel({
  actions,
  timezone,
  hydrated,
  onUndo,
}: {
  actions: TaskSegmentActions
  timezone: string
  /** The reminders fetch has landed (`useReminders().hydrated`): the segments are today's. */
  hydrated: boolean
  /** The dashboard's undo (a select-mode toast's Undo). */
  onUndo: () => void
}) {
  // Select mode (2026-10-30): "Select" in the header, checkboxes on the rows,
  // the U1 bar once something is picked (`QueueSelect`).
  const select = useQueueSelectMode({ actions, timezone, onUndo })
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
      mark: stripMarkFor(segment.horizon, segment.pulled),
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
  // Bring the card into view, once (the link's page is shown on it).
  useEffect(() => {
    if (!scrollPending.current) return
    scrollPending.current = false
    sectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })
  if (!pager) return null
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
      // A stop of the Dashboard tab's re-tap walk while a segment waits
      // (src/lib/retap-walk.ts).
      data-retap-stop
      data-needs-you={pages.some((p) => p.waiting > 0) ? '' : undefined}
      className="bg-muted/30 scroll-below-header mb-6 overflow-hidden rounded-2xl"
    >
      <SlotPagerHeader
        // "Task queue" on every page (2026-10-29); the strip's words say which.
        label={TASK_QUEUE_TITLE}
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
        // No sweeps while selecting (2026-10-30): the bar has Consider and
        // Not today for the picked rows, and with "Select" in the header the
        // two pushed it past a 402 phone's width at the app's 119% text.
        sweep={
          expanded && page.waiting > 0 && !select.on ? (
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
                  ariaLabel={`Not today: all ${page.waiting} in ${page.label}`}
                  onClick={() => void actions.deferAll(segment)}
                />
              )}
            </>
          ) : null
        }
        beforeCount={<QueueSelectToggle on={select.on} onToggle={select.toggleMode} />}
        compact={select.on}
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
      <QueueSelectEnterContext.Provider value={select.enter}>
        <QueueSelectContext.Provider value={select.state}>
          <TaskPageBody
            segment={segment}
            actions={actions}
            timezone={timezone}
            expanded={expanded}
            showConsidered={showConsidered}
            onToggleExpanded={() => setExpanded(!expanded)}
          />
        </QueueSelectContext.Provider>
      </QueueSelectEnterContext.Provider>
      {select.bar}
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
          {visible.map((row, i) => {
            const narrowHidden = !expanded && i >= NARROW_CAP
            // Aged out's group headings, Pulled's sections (2026-10-29).
            const heading = agedGroupBefore(segment.horizon, visible, i)
            const pulled = pulledSectionBefore(segment, visible, i)
            return (
              <Fragment key={row.task.id}>
                {heading && <AgedGroupHeading {...heading} panel hiddenWhenNarrow={narrowHidden} />}
                {pulled && (
                  <PulledSectionHeading {...pulled} panel hiddenWhenNarrow={narrowHidden} />
                )}
                <TaskSegmentRow
                  row={row}
                  actions={actions}
                  timezone={timezone}
                  panel
                  segmentHorizon={rowKind(segment, row)}
                  hiddenWhenNarrow={narrowHidden}
                />
              </Fragment>
            )
          })}
        </ul>
      )}
      {!upcoming && showConsidered && handled.length > 0 && (
        <ul className="space-y-0.5 px-2 pb-1" aria-label={`Considered in ${label}`}>
          {handled.map((row) => (
            <ConsideredSegmentRow
              key={row.task.id}
              row={row}
              panel
              segmentHorizon={segment.horizon}
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
