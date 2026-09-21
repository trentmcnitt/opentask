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
 * ONE HUE ONLY, AND IT IS GREEN. A first cut tinted the track violet for
 * "behind" and filled it green for progress; Trent, 2026-09-21: "the purple
 * background is not good. Green and purple don't seem to go together." He was
 * right, and the reason is that it ran two colour languages at once — hue for
 * state, fill for progress — so the two competed in the same 4px of bar. Now
 * green is the only colour on the instrument and it means exactly what it
 * means everywhere else in this app (considered, met, done). State is carried
 * by the WEIGHT of the neutral track instead: present for a slot whose time
 * has come, nearly invisible for one whose time has not.
 *
 * Nothing here is ever red or amber. §6: a reminder is never overdue and
 * carries no debt, so the bar may report that a slot is unfinished but must
 * never dress it as a failure.
 */

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
  if (groups.length < 2) return null

  return (
    <div
      className="flex items-center gap-1 px-3 pb-2"
      role="group"
      aria-label="Today's reminder slots"
    >
      {groups.map((group, i) => {
        const started = hasStarted(group, timezone, now)
        const state = slotState(group, started)
        const total = group.reminders.length + group.considered
        const fraction = total > 0 ? group.considered / total : 0
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
            aria-label={
              total === 0
                ? `${label}, nothing today`
                : `${label}, ${group.considered} of ${total} considered${
                    state === 'upcoming' ? ', not started yet' : ''
                  }`
            }
            title={total === 0 ? label : `${label} — ${group.considered}/${total}`}
            className="group flex min-w-0 flex-1 items-center py-1"
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
                  className="block h-full rounded-full bg-green-600 transition-[width] duration-300 ease-out"
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
