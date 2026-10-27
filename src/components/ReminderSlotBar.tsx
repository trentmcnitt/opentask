'use client'

import { Fragment } from 'react'
import { cn } from '@/lib/utils'

/**
 * The whole day's slots as one thin bar, under the pager.
 *
 * Trent, 2026-09-21: "I need some indication of which time periods don't have
 * things done... I need to be able to see if early morning's done, if midday's
 * done." A badge on the pager chevrons could only ever describe the slot next
 * door; this is a whole-day question, so it wants a whole-day instrument. Each
 * segment is also a tap target that pages to its slot, which was his idea too.
 *
 * THREE STATES, AND THE THIRD ONE IS THE POINT. A slot that has not started
 * yet is drawn as a plain empty track — no colour, no count, nothing to answer
 * for. Trent, same message: "The things that haven't happened yet don't need a
 * color or anything. They're obviously going to be undone." So the only slot
 * that wears the accent is one whose time has come and still has thoughts
 * waiting; that is what "needs work" means here, and nothing else competes
 * with it for attention.
 *
 * ONE HUE ONLY, AND IT WAS GREEN — for a while. A first cut tinted the track
 * violet for "behind" and filled it green for progress; Trent, 2026-09-21:
 * "the purple background is not good. Green and purple don't seem to go
 * together." He was right, and the reason is that it ran two colour languages
 * at once — hue for state, fill for progress — so the two competed in the
 * same 4px of bar to say the SAME thing. Green became the only colour on the
 * instrument, meaning exactly what it means everywhere else in this app
 * (considered, met, done), and state was carried by the WEIGHT of the neutral
 * track instead: present for a slot whose time has come, nearly invisible for
 * one whose time has not.
 *
 * REVISED 2026-09-22: TWO HUES, ON PURPOSE THIS TIME. That single-hue bar had
 * a blind spot — "10 of 11" and "11 of 11" rendered almost identically, the
 * only difference a sliver of grey track a few pixels wide. Trent: "it'd be
 * nice if there was some indication when something was actually finished...
 * it's hard to see the difference between a completed green segment and
 * something that's nearly complete." His fix: "one color when it's filling,
 * another color when it's finished." This is NOT the violet mistake come
 * back — that cut ran two hues to express the same thing (state) in the same
 * space, and they fought each other. This runs two hues to express two
 * DIFFERENT things: the filling hue (blue then; PURPLE since 2026-10-26,
 * below) means "time has come, still filling in"; green still means only
 * what it always has here — fully considered. The fill is what
 * changes hue now, gated on nothing left waiting (`considered >= total`),
 * not on `state`, so a slot fully considered before its own time has come
 * (still `'upcoming'`) reads as finished rather than lying "still filling". The track
 * underneath is untouched by any of this — still weight-only, still the tell
 * for "behind" vs "upcoming".
 *
 * THE RULE NOW (2026-10-26): PURPLE WHILE FILLING, GREEN WHEN DONE, ON EVERY
 * SEGMENT; THE DEADLINES PAGE FINISHES IN ITS TEAL. The blue
 * became the reminders' own purple (`--badge-reminders`), and the task
 * segments, which had filled in one teal each, fill in it too (Trent: "Have
 * them all just use the purple and green except for the deadlines, which
 * finish the teal color that they currently finish at. That's the special
 * one." — a teal per segment made the page too noisy). Finished is green
 * on every segment except the deadlines page, which finishes in its own
 * teal (`doneColor`). The Reminders page's day bar and section hairlines
 * and the Quotas page's period bars follow the same rule.
 *
 * Nothing here is ever red or amber. §6: a reminder is never overdue and
 * carries no debt, so the bar may report that a slot is unfinished but must
 * never dress it as a failure. Purple reads as "in progress", not "wrong".
 *
 * SEGMENTS ARE PROPORTIONAL TO WHAT THEY HOLD. Equal widths were the first
 * cut, on the reasoning that Trent's own slots happen to be evenly sized so
 * proportion would buy little. He rejected the reasoning rather than the
 * finding, 2026-09-21: "My slots are naturally even but that's not
 * necessarily the case" — a layout should not depend on today's data staying
 * shaped the way it is. So width keys off the slot's TOTAL (waiting plus
 * considered), which is fixed for the day: checking things off moves the green
 * fill inside a segment but never resizes it, so the bar never squirms while
 * it is being used.
 *
 * `MIN_SEGMENT_PX` is what keeps that honest. His own worry: "Something that
 * had 1 reminder out of 50 wouldn't be able to tap something that small."
 * Flexbox honours the minimum first and shares what is left by weight, so a
 * tiny slot stays hittable and only the surplus is distributed.
 *
 * TASK SEGMENTS ARE SEGMENTS TOO (2026-10-11). The panel pages through each
 * task segment after the slots (Trent: "days, weeks, etc. should be individual
 * segments and behave similarly to the segments for reminders"), so each gets
 * a bar here, after the slots' — same states, same proportions, same tap. The
 * bar takes plain items rather than `ReminderGroup`s for that reason. A task
 * segment has no start time: it is today's all day, so it is "started" and
 * fills while anything in it waits, green once it is all handled.
 */

/** Small enough to stay roughly proportional, wide enough to hit. Shared with
 *  the Reminders page's day bar, whose segments are tap targets too. */
export const MIN_SEGMENT_PX = 28

/** One page of the panel's pager, as the bar sees it. */
export interface SlotBarItem {
  /** `slotGroupKey` for a slot, "tasks:<horizon>" for a task segment. */
  key: string
  label: string
  /** Handled today: considered (and, for a task segment, deferred). */
  considered: number
  /** Its size today: waiting + handled. Fixed for the day, so widths hold. */
  total: number
  /** Its time has come. Always true for a task segment. */
  started: boolean
  /** A task segment, not a slot: the divider goes before the first one. It
   *  fills in the same purple as a slot; the page on screen grows like a
   *  slot's, with no ring. */
  taskSegment?: boolean
  /** Its fill once finished, in place of green: the deadlines page's teal
   *  (`segmentDoneColor`). Absent for a slot and every other segment. */
  doneColor?: string
  /**
   * EMPTY IS DONE (a task segment, Trent 2026-10-24: "always show every queue
   * segment, every day, in fixed positions"). With this set an item holding
   * nothing keeps its place in the strip, drawn finished — a full green bar —
   * from the start of the day. Without it (a slot) an empty item gets no
   * segment, the 09-21 rule below.
   */
  emptyDone?: boolean
}

/**
 * The faint divider between the last slot's bar and the first task segment's
 * (2026-10-11, Trent's pick of the mockups: "a thin divider between slots and
 * tasks"). Only when the strip has both. Shared with the Reminders page's day
 * bar.
 */
export function SegmentDivider() {
  return (
    <span aria-hidden data-segment-divider className="bg-foreground/20 mx-1 h-3 w-px shrink-0" />
  )
}

/** What a segment is saying. */
type SlotState = 'done' | 'behind' | 'upcoming'

function slotState(item: SlotBarItem): SlotState {
  if (item.emptyDone && item.total === 0) return 'done'
  const waiting = item.total - item.considered
  if (item.started && waiting === 0 && item.considered > 0) return 'done'
  if (item.started && waiting > 0) return 'behind'
  return 'upcoming'
}

export function ReminderSlotBar({
  items,
  currentIndex,
  onJump,
  ariaLabel = "Today's reminder slots",
}: {
  /** Every page, in pager order: the slots, then the task segments. */
  items: SlotBarItem[]
  /** The page on screen, so it can be marked "you are here". */
  currentIndex: number
  onJump: (index: number) => void
  /** The group's name: the slots' strip, or the Tasks card's. */
  ariaLabel?: string
}) {
  // AN EMPTY SECTION GETS NO SEGMENT. Trent, 2026-09-21: "for the 'anytime' if
  // a section does not have anything in it, it doesn't need a segment." It
  // came up for the un-slotted bucket, which is empty most days, but the rule
  // is general: a segment is a claim that there is something there, and a
  // slot holding nothing has nothing to report, nothing to finish and nothing
  // worth paging to. The original index rides along so a tap still lands on
  // the right page after the empty ones are dropped. A task segment is the
  // exception (`emptyDone`, 2026-10-24): it always has its place, drawn done.
  const shown = items
    .map((item, index) => ({ item, index }))
    .filter((s) => s.item.total > 0 || s.item.emptyDone)

  // One segment is not a bar — it would say only "everything is here", which
  // the header already says better.
  if (shown.length < 2) return null

  return (
    <div className="flex items-center gap-1 px-3 pb-2" role="group" aria-label={ariaLabel}>
      {shown.map(({ item, index: i }, n) => {
        const { considered, total, label, doneColor } = item
        // The divider goes before the first task segment, after a slot.
        const divider = item.taskSegment && n > 0 && !shown[n - 1].item.taskSegment
        const state = slotState(item)
        // An empty task segment is done: a full green fill (`emptyDone`).
        const fraction = total > 0 ? considered / total : 1
        // Gated on the numbers, not on `state`: `state` only calls a slot
        // 'done' once it has STARTED, but a slot can be fully considered
        // ahead of its own start time (still 'upcoming') and the fill must
        // not call that "still filling" — see the header comment.
        const complete = considered >= total
        const current = i === currentIndex

        return (
          <Fragment key={item.key}>
            {divider && <SegmentDivider />}
            <button
              type="button"
              onClick={() => onJump(i)}
              data-slot-segment={item.key}
              data-slot-state={state}
              aria-current={current ? 'true' : undefined}
              // The name carries what the colour cannot: which slot, and how far
              // through it is. A bar of five unlabelled segments is meaningless
              // to a screen reader otherwise.
              aria-label={`${label}, ${considered} of ${total} considered${
                state === 'upcoming' ? ', not started yet' : ''
              }`}
              title={`${label} — ${considered}/${total}`}
              className="group flex items-center py-1"
              style={{
                // Weight by size, but never below a thumb. `flexBasis: 0` makes
                // grow the only thing deciding width. Only an empty task
                // segment (`emptyDone`) weighs zero: it is exactly the minimum.
                flexGrow: total,
                flexBasis: 0,
                minWidth: MIN_SEGMENT_PX,
              }}
            >
              <span
                className={cn(
                  'w-full overflow-hidden rounded-full transition-all',
                  // The slot on screen is the taller one — position without a
                  // second colour, which the three states already spend.
                  current ? 'h-2' : 'h-1',
                  // A task segment's page grows like a slot's and is NOT ringed
                  // (Trent, 2026-10-11: "The reminder segments don't have an
                  // outline and neither should this. It should just grow").
                  // Its time has come: a track with real presence, so the
                  // unfilled part reads as "still to do".
                  state === 'behind' && 'bg-foreground/20',
                  // (Under a finished fill in its own colour, a plain grey
                  // track rather than green's tint: `doneColor`.)
                  state === 'done' && (doneColor ? 'bg-foreground/20' : 'bg-green-600/20'),
                  // Nothing has happened here yet, and that is not a problem —
                  // barely there, so it never competes for attention.
                  state === 'upcoming' && 'bg-foreground/[0.06]',
                  'group-hover:brightness-125',
                )}
              >
                {fraction > 0 && (
                  <span
                    className={cn(
                      // Purple while there's still something waiting; green the
                      // moment there isn't. A step change in colour, not an
                      // increment in length — see the header comment.
                      'block h-full rounded-full transition-[width,background-color] duration-300 ease-out',
                      complete ? !doneColor && 'bg-green-600' : 'bg-badge-reminders',
                    )}
                    style={{
                      width: `${Math.min(1, fraction) * 100}%`,
                      // Done in its own `doneColor` (the deadlines page's teal)
                      // in place of green.
                      ...(doneColor && complete ? { backgroundColor: doneColor } : {}),
                    }}
                  />
                )}
              </span>
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}
