'use client'

import { cn } from '@/lib/utils'
import { parseHHMM } from '@/lib/time-slot-assign'
import type { ReminderGroup } from '@/hooks/useReminders'
import { DateTime } from 'luxon'

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
 * DIFFERENT things: blue means "time has come, still filling in"; green still
 * means only what it always has here — fully considered. The fill is what
 * changes hue now, gated on nothing left waiting (`considered >= total`),
 * not on `state`, so a slot fully considered before its own time has come
 * (still `'upcoming'`) reads as finished rather than lying blue. The track
 * underneath is untouched by any of this — still weight-only, still the tell
 * for "behind" vs "upcoming".
 *
 * Nothing here is ever red or amber. §6: a reminder is never overdue and
 * carries no debt, so the bar may report that a slot is unfinished but must
 * never dress it as a failure. Blue reads as "in progress", not "wrong".
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
 */

/** Small enough to stay roughly proportional, wide enough to hit. */
const MIN_SEGMENT_PX = 28

/** What a segment is saying. */
type SlotState = 'done' | 'behind' | 'upcoming'

function slotState(group: ReminderGroup, startedAlready: boolean): SlotState {
  const waiting = group.reminders.length
  if (startedAlready && waiting === 0 && group.considered > 0) return 'done'
  if (startedAlready && waiting > 0) return 'behind'
  return 'upcoming'
}

/**
 * Has this slot's time arrived?
 *
 * The un-slotted "Anytime" bucket has no start time and is always available,
 * so it counts as started — it is never "coming up later".
 */
function hasStarted(group: ReminderGroup, timezone: string, now: Date): boolean {
  if (!group.slot) return true
  const start = parseHHMM(group.slot.start_time)
  if (start === null) return true
  const local = DateTime.fromJSDate(now).setZone(timezone)
  if (!local.isValid) return true
  return local.hour * 60 + local.minute >= start
}

export function ReminderSlotBar({
  groups,
  currentIndex,
  timezone,
  now,
  onJump,
}: {
  groups: ReminderGroup[]
  /** The slot on screen, so it can be marked "you are here". */
  currentIndex: number
  timezone: string
  /** Passed in rather than read here, so the panel's one clock drives both
   *  this and its own natural-slot maths. */
  now: Date
  onJump: (index: number) => void
}) {
  // AN EMPTY SECTION GETS NO SEGMENT. Trent, 2026-09-21: "for the 'anytime' if
  // a section does not have anything in it, it doesn't need a segment." It
  // came up for the un-slotted bucket, which is empty most days, but the rule
  // is general: a segment is a claim that there is something there, and a
  // slot holding nothing has nothing to report, nothing to finish and nothing
  // worth paging to. The original index rides along so a tap still lands on
  // the right slot after the empty ones are dropped.
  const shown = groups
    .map((group, index) => ({ group, index, total: group.reminders.length + group.considered }))
    .filter((s) => s.total > 0)

  // One segment is not a bar — it would say only "everything is here", which
  // the header already says better.
  if (shown.length < 2) return null

  return (
    <div
      className="flex items-center gap-1 px-3 pb-2"
      role="group"
      aria-label="Today's reminder slots"
    >
      {shown.map(({ group, index: i, total }) => {
        const started = hasStarted(group, timezone, now)
        const state = slotState(group, started)
        const fraction = group.considered / total
        // Gated on the numbers, not on `state`: `state` only calls a slot
        // 'done' once it has STARTED, but a slot can be fully considered
        // ahead of its own start time (still 'upcoming') and the fill must
        // not call that "still filling" — see the header comment.
        const complete = group.considered >= total
        const label = group.slot?.label ?? 'Anytime'
        const current = i === currentIndex

        return (
          <button
            key={group.slot?.id ?? 'unslotted'}
            type="button"
            onClick={() => onJump(i)}
            data-slot-segment={group.slot?.id ?? 'unslotted'}
            data-slot-state={state}
            aria-current={current ? 'true' : undefined}
            // The name carries what the colour cannot: which slot, and how far
            // through it is. A bar of five unlabelled segments is meaningless
            // to a screen reader otherwise.
            aria-label={`${label}, ${group.considered} of ${total} considered${
              state === 'upcoming' ? ', not started yet' : ''
            }`}
            title={`${label} — ${group.considered}/${total}`}
            className="group flex items-center py-1"
            style={{
              // Weight by size, but never below a thumb. `flexBasis: 0` makes
              // grow the only thing deciding width, and every segment here
              // holds at least one thought, so the weight is never zero.
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
                // Its time has come: a track with real presence, so the
                // unfilled part reads as "still to do".
                state === 'behind' && 'bg-foreground/20',
                state === 'done' && 'bg-green-600/20',
                // Nothing has happened here yet, and that is not a problem —
                // barely there, so it never competes for attention.
                state === 'upcoming' && 'bg-foreground/[0.06]',
                'group-hover:brightness-125',
              )}
            >
              {fraction > 0 && (
                <span
                  className={cn(
                    // Blue while there's still something waiting; green the
                    // moment there isn't. A step change in colour, not an
                    // increment in length — see the header comment.
                    'block h-full rounded-full transition-[width,background-color] duration-300 ease-out',
                    complete ? 'bg-green-600' : 'bg-indigo-600',
                  )}
                  style={{ width: `${Math.min(1, fraction) * 100}%` }}
                />
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
