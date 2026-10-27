'use client'

import { Fragment, type ReactNode } from 'react'
import { CheckCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatClockTime } from '@/lib/time-utils'
import { slotGroupKey, slotLabel } from '@/lib/reminder-slots'
import {
  dayCountLabel,
  dayCountRuns,
  dayDoneRuns,
  headlineCounts,
  tasksWaitingText,
  waitingSoFarRuns,
  type CountPart,
  type HeadlineCounts,
  type RemindersSummary,
} from '@/lib/reminders-summary'
import { groupConsidered, groupWaiting } from '@/lib/quota-prompts'
import type { ReminderGroup } from '@/hooks/useReminders'
import { MIN_SEGMENT_PX, SegmentDivider } from '@/components/ReminderSlotBar'
import {
  segmentCounts,
  segmentDoneColor,
  segmentKey,
  segmentLabel,
} from '@/components/TaskSegmentRow'
import type { SegmentView } from '@/hooks/useTaskSegments'

/**
 * The headline: one short line for "what now" (never a breakdown — the slot
 * headers below ARE the breakdown, one per line), the one-tap "Considered all
 * so far", and the day's bar.
 *
 * The bar is segmented, one segment per slot in the same order as the groups
 * below and sized by how much each slot held today, so the shape of the day
 * is readable at a glance and every considered thought visibly moves it.
 * Slots that haven't started yet are drawn fainter: "not yet" must not read
 * as "not done". A segment turns green when its slot is finished — a small
 * win each time — and the number goes green when the day is.
 *
 * The task segments follow the slots (2026-10-11), after a faint divider, in
 * the same purple as a slot while filling and green when done (the deadlines
 * page: its teal) — every one, every day (2026-10-24; an empty one done) —
 * the dashboard strip's bars, so a segment reads the same on
 * both surfaces; a tap scrolls to its section.
 *
 * REMINDERS AND TASKS, COUNTED APART (Trent, 2026-10-26, ruling "B": count
 * "reminders and queue tasks SEPARATELY, e.g. '75 reminders · 84 tasks
 * considered'"). With the task queue on, the line and the count count what
 * the bar draws — the periods as reminders, every task segment as tasks, by
 * each segment's own header numbers (`headlineCounts`, `segmentCounts`) — so
 * the sum always matches the bar. Before the split task rows never counted
 * here; they still never count in the nav badge or "Considered all so far"
 * (docs/TASK-MODEL.md § Task segments). The states (a half with nothing in
 * it is dropped — never "0 tasks"):
 *
 *   line    "14 reminders · 3 tasks waiting so far" / "3 tasks waiting so far"
 *           "Caught up until Evening · 6:00 PM" (only later periods hold
 *           reminders), "… · 6:00 PM · 3 tasks waiting" while tasks wait
 *           (Trent, 2026-10-26: keep the caught-up phrase, append the tasks)
 *           "All clear for today" (nothing waiting of either kind)
 *   count   "40 of 75 reminders · 30 of 84 tasks considered"
 *   done    "All 75 reminders · 84 tasks considered today", green — only
 *           once BOTH halves are handled
 *
 * FULL WORDS AT EVERY WIDTH; ON A PHONE THE COUNT GETS ITS OWN LINE (Trent,
 * 2026-10-26, layout "b"; no "rem" abbreviation anywhere). Beside the bar the
 * full words left a phone's bar 0-2px wide, so below 640px the count drops
 * under the bar, which keeps the whole width. Every line there wraps only at
 * a " · ", never inside a run (it broke "waiting so / far" beside "All so
 * far"). From 640px up it is one line, the count beside the bar.
 *
 * With the switch off (or no segment drawn) the words read as before the
 * split: "14 waiting so far", "40 of 75 considered", "All 75 considered
 * today" — the segments still on the bar, uncounted. (A phone's count is
 * full words under the bar there too; it was "40 / 75" beside it.)
 */
export function RemindersHeadline({
  summary,
  allWaitingDone,
  onConsiderSoFar,
  onGoToSlot,
  taskSegments = [],
  countTasks = false,
}: {
  summary: RemindersSummary<ReminderGroup>
  allWaitingDone: boolean
  onConsiderSoFar: () => void
  /** A segment was tapped: open that slot and scroll to it (`goToSlot` in `RemindersView`). */
  onGoToSlot: (key: string) => void
  /** Today's task segments, drawn after the slots. */
  taskSegments?: SegmentView[]
  /** Count the task segments as the tasks half (the task queue is on). */
  countTasks?: boolean
}) {
  const counts = headlineCounts(
    summary,
    countTasks && taskSegments.length > 0 ? taskSegments.map(segmentCounts) : null,
  )
  const segments = [...summary.started, ...summary.later]
  // THE BAR FITS (2026-10-24). With every task segment on the bar every
  // day, five or six periods and eight segments at their thumb-wide minimum
  // are wider than a phone — the bar pushed the count off the screen (7px
  // sideways scroll at 375 on real data). So the bar takes the width it is
  // given (beside the count from 640px, `sm:flex-1 min-w-0`; the whole row on
  // a phone, the count on the line under it — layout "b", 2026-10-26),
  // measured as a size container, and each segment's minimum is its thumb
  // width OR its even share of the bar, whichever is smaller (`fitShare`):
  // with room, nothing changes; without, every segment gives way evenly and
  // the minimums never add up to more than the bar.
  const showDivider = taskSegments.length > 0 && segments.length > 0
  const share = fitShare(segments.length + taskSegments.length, showDivider)
  const dayDone = counts.done

  return (
    <div className="mb-4 px-2" data-reminders-headline>
      <div className="flex items-center justify-between gap-3">
        <h1 className="min-w-0 text-sm">
          <HeadlineLine summary={summary} counts={counts} allWaitingDone={allWaitingDone} />
        </h1>
        {summary.waitingSoFar > 0 && (
          <button
            type="button"
            onClick={onConsiderSoFar}
            // Reminders only (Consider-all for tasks is on hold): with a task
            // half it says so, as the line beside it counts both.
            aria-label={`Mark all ${summary.waitingSoFar}${counts.tasks ? ' reminders' : ''} waiting so far as considered`}
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
          >
            <CheckCheck className="size-3.5" strokeWidth={2.5} />
            <span className="hidden sm:inline">Considered all so far</span>
            <span className="sm:hidden">All so far</span>
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-col sm:flex-row sm:items-center" data-day-row>
        {/* EACH SEGMENT GOES TO ITS PERIOD (2026-09-25) — the dashboard card's
            `ReminderSlotBar` pages to a slot on a tap, and this is the same
            idea on a page that scrolls: open the section if it was folded,
            then bring its header up under the top bar (`goToSlot`, the
            `?slot=` deep link's own move). So the segments are buttons in a
            group, and the day's progressbar semantics moved to the count
            beside them — a progressbar's children are presentational, so it
            cannot hold anything a keyboard or a screen reader can press.
            Every segment is at least the card bar's `MIN_SEGMENT_PX` wide (it
            was 6px while the bar was only a picture): a period holding 1 of
            the day's 60 must still be something a thumb can hit, Trent's own
            worry about that bar. The hit area is also taller than the 8px bar (padding, cancelled by the
            negative margin) so a thumb can land on it; hover only darkens the
            track a shade, since the fill is the thing to read. */}
        <div
          className="-my-1.5 flex min-w-0 gap-[3px] sm:flex-1"
          style={{ containerType: 'inline-size' }}
          role="group"
          aria-label="Go to a period"
          data-day-bar
        >
          {segments.map((g) => {
            const considered = groupConsidered(g)
            const key = slotGroupKey(g)
            return (
              <DayBarButton
                key={key}
                id={key}
                label={slotLabel(g)}
                considered={considered}
                total={groupWaiting(g) + considered}
                started={summary.started.includes(g)}
                share={share}
                onClick={() => onGoToSlot(key)}
              />
            )
          })}
          {showDivider && (
            <span className="flex items-center self-center">
              <SegmentDivider />
            </span>
          )}
          {taskSegments.map((segment) => {
            const { handled, total } = segmentCounts(segment)
            const key = segmentKey(segment)
            return (
              <DayBarButton
                key={key}
                id={key}
                label={segmentLabel(segment)}
                considered={handled}
                total={total}
                started
                doneColor={segmentDoneColor(segment.horizon)}
                emptyDone
                share={share}
                onClick={() => onGoToSlot(key)}
              />
            )
          })}
        </div>
        <span
          className="mt-2 shrink-0 text-xs tabular-nums sm:mt-0 sm:ml-3 sm:whitespace-nowrap"
          data-day-count
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={counts.total}
          aria-valuenow={counts.handled}
          aria-label={dayCountLabel(counts)}
        >
          {dayDone ? (
            <span className="text-green-700 dark:text-green-400">
              <Runs runs={dayDoneRuns(counts)} />
            </span>
          ) : (
            <CountRuns runs={dayCountRuns(counts)} />
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * The headline's one line: "All clear for today" once nothing of either kind
 * waits, "Caught up until …" while only later periods hold reminders (any
 * tasks waiting appended), else
 * what is waiting so far (both halves — the states in the docblock above).
 */
function HeadlineLine({
  summary,
  counts,
  allWaitingDone,
}: {
  summary: RemindersSummary<ReminderGroup>
  counts: HeadlineCounts
  allWaitingDone: boolean
}) {
  const tasksWaiting = counts.tasks?.waiting ?? 0
  if (allWaitingDone && tasksWaiting === 0) {
    return <span className="text-foreground font-medium">All clear for today</span>
  }
  // Caught up: no reminder waits in a started period, a later one holds
  // some. Tasks waiting no longer take the phrase away (Trent, 2026-10-26):
  // they are appended, "Caught up until Evening · 6:00 PM · 3 tasks waiting".
  if (summary.waitingSoFar === 0 && summary.nextUp) {
    return (
      <span data-caught-up data-tasks-waiting={counts.tasks ? tasksWaiting : undefined}>
        <Joined
          items={[
            <span key="until" className="text-foreground font-medium">
              Caught up until {summary.nextUp.slot.label}
            </span>,
            <span key="at" className="text-muted-foreground">
              {formatClockTime(summary.nextUp.slot.start_time)}
            </span>,
            ...(tasksWaiting > 0
              ? [
                  <span key="tasks" className="text-foreground font-medium">
                    {tasksWaitingText(tasksWaiting)}
                  </span>,
                ]
              : []),
          ]}
        />
      </span>
    )
  }
  return (
    <span
      className="text-foreground font-medium"
      data-waiting-so-far={summary.waitingSoFar}
      data-tasks-waiting={counts.tasks ? tasksWaiting : undefined}
    >
      <Runs runs={waitingSoFarRuns(counts)} />
    </span>
  )
}

/**
 * Runs joined by " · ", each unbroken, so a line wraps only between them — and
 * a wrapped line never ends (or starts) with the dot (Trent, 2026-10-26: "drop
 * the dot at the wrap"). CSS can't ask "did this break here?", so each item
 * carries its separator at its START, and the whole line is shifted left by one
 * separator's width inside a box that clips: a separator that begins a line
 * (the first item's, or one after a wrap) lands in the clipped strip and
 * vanishes, while one mid-line shows as usual. The first item's box is
 * empty: it only fills the clipped strip, so the text never starts with a dot. (Non-breaking spaces round the
 * dot keep the text " · " for search and tests; the box's fixed width is what
 * the shift cancels.) `<wbr>` between items is the
 * break opportunity (no space, so nothing else moves). The separator is
 * `aria-hidden`: a screen reader hears the runs, not the dots.
 */
function Joined({ items }: { items: ReactNode[] }) {
  return (
    <span className="block overflow-hidden" data-joined>
      <span className="-ml-[0.85em] block">
        {items.map((item, i) => (
          <Fragment key={i}>
            {i > 0 && <wbr />}
            <span className="whitespace-nowrap" data-joined-item>
              <span
                data-joined-sep
                aria-hidden
                className="text-muted-foreground inline-block w-[0.85em] text-center"
              >
                {i > 0 ? '\u00a0·\u00a0' : null}
              </span>
              {item}
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  )
}

/** Runs of plain text joined by " · " (`Joined`). */
function Runs({ runs }: { runs: string[] }) {
  return <Joined items={runs} />
}

/**
 * The open day's count, one unbroken run per half joined by " · " (a phone
 * wraps only between them): each handled number in the foreground, the rest
 * muted.
 */
function CountRuns({ runs }: { runs: CountPart[][] }) {
  return (
    <Joined
      items={runs.map((run, i) => (
        <span key={i}>
          {run.map((p, j) => (
            <span
              key={j}
              className={p.strong ? 'text-foreground font-medium' : 'text-muted-foreground'}
            >
              {p.text}
            </span>
          ))}
        </span>
      ))}
    />
  )
}

/** How narrow an empty task segment's bar may get when the day bar runs out of room. */
const EMPTY_SEGMENT_MIN_PX = 12

/** The bar's `gap-[3px]`, and the divider's width with its `mx-1` (`SegmentDivider`). */
const BAR_GAP_PX = 3
const DIVIDER_PX = 9

/**
 * One segment's even share of the day bar (a CSS length, in the bar's own
 * `cqw` — it is a size container): the bar's width less its gaps and the
 * divider, over the number of segments. A segment's minimum is never more
 * than this, so the minimums always add up to no more than the bar.
 */
function fitShare(count: number, divider: boolean): string {
  const children = count + (divider ? 1 : 0)
  const fixed = Math.max(0, children - 1) * BAR_GAP_PX + (divider ? DIVIDER_PX : 0)
  return `calc((100cqw - ${fixed}px) / ${Math.max(1, count)})`
}

/**
 * One segment of the day bar: a slot or a task segment. Purple while still
 * filling, green the moment it's done (the deadlines page: its teal) —
 * matches the dashboard's `ReminderSlotBar` (two hues since 2026-09-22,
 * purple and one rule for every segment since 2026-10-26), so a segment
 * reads the same way on both surfaces.
 */
function DayBarButton({
  id,
  label,
  considered,
  total,
  started,
  doneColor,
  emptyDone = false,
  share,
  onClick,
}: {
  id: string
  label: string
  considered: number
  total: number
  started: boolean
  /** Its fill once done, in place of green: the deadlines page's teal (`segmentDoneColor`). */
  doneColor?: string
  /** An empty task segment is done (2026-10-24): a full green bar from the start of the day. */
  emptyDone?: boolean
  /** Its even share of the bar (`fitShare`): the most its minimum may be. */
  share: string
  onClick: () => void
}) {
  const done = total > 0 ? considered >= total : emptyDone
  return (
    <button
      type="button"
      onClick={onClick}
      data-day-segment={id}
      data-day-segment-done={done ? '' : undefined}
      aria-label={`Go to ${label}, ${considered} of ${total} considered`}
      title={`${label} · ${considered} of ${total} considered`}
      style={
        total === 0 && emptyDone
          ? // An EMPTY task segment (2026-10-24): every one is on the bar every
            // day, so on a phone with several periods eight thumb-wide bars
            // would push the bar past the screen. An empty one asks for the
            // same width as any other, but alone may give way (to
            // EMPTY_SEGMENT_MIN_PX) when the row runs out of room — it holds
            // nothing to tap through to.
            {
              flexGrow: 0,
              flexShrink: 1,
              flexBasis: MIN_SEGMENT_PX,
              minWidth: `min(${EMPTY_SEGMENT_MIN_PX}px, ${share})`,
            }
          : { flexGrow: total, flexBasis: 0, minWidth: `min(${MIN_SEGMENT_PX}px, ${share})` }
      }
      className="group rounded-full py-1.5 focus-visible:outline-none"
    >
      <span
        className={cn(
          'relative block h-2 overflow-hidden rounded-full transition-colors',
          'group-focus-visible:ring-ring group-focus-visible:ring-offset-background group-focus-visible:ring-2 group-focus-visible:ring-offset-1',
          started
            ? 'bg-muted group-hover:bg-foreground/15'
            : 'bg-muted/50 group-hover:bg-foreground/10',
        )}
      >
        <span
          className={cn(
            'block h-full rounded-full transition-[width,background-color] duration-500 ease-out',
            // Purple while it fills, slot or task segment alike (2026-10-26,
            // `ReminderSlotBar`'s header); green when done.
            done ? !doneColor && 'bg-green-600' : 'bg-badge-reminders',
          )}
          style={{
            width: `${total > 0 ? (considered / total) * 100 : done ? 100 : 0}%`,
            ...(doneColor && done ? { backgroundColor: doneColor } : {}),
          }}
        />
      </span>
    </button>
  )
}
