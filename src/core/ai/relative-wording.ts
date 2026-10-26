/**
 * RELATIVE TARGETS FROM WORDING (2026-10-24, PR C; plan
 * `plan-relative-targets-1024.md` §5, rulings 9 and 10, decision 12;
 * docs/TASK-MODEL.md § Relative targets).
 *
 * "Submit it by Tue 8:30am, remind me the evening before" asks for a target
 * counted back from the deadline, which follows the deadline when it moves.
 * The model answers three fields — `target_days_before`, `target_time` (a
 * clock time the user said, else null) and `target_period` (the part of the
 * day they said, in their word, or a listed period's exact name) — and this
 * module turns them into what is stored: (days, time, period link). It is
 * pure (the periods and the Default task time are arguments), so production
 * (`postProcessTaskDates`) and the quality harness run the same code.
 *
 * Only relative WORDING makes a target relative (ruling 9): `RELATIVE_CUE`
 * is the floor `sanitizeTaskModelFields` holds the model to, as
 * `DEADLINE_CUE` is for deadlines.
 *
 * THE TIME, one ordered table (`relativeTargetTime`; never asks):
 *  1. A clock time the user said ("at 6pm the day before") → that time,
 *     custom. Only when the words hold a clock time at all, and — when they
 *     also name a part of the day — one inside it (the deadline's own "8:30am"
 *     is not the evening before's time).
 *  2. "morning", or no part of the day ("the day before", "2 days before") →
 *     the Default task time (`users.morning_time`), COPIED as it is: linked
 *     to its period if it is linked, else custom (ruling 10). "Morning"
 *     means the Default task time everywhere in enrichment, so this holds
 *     even when the user has a period named Morning.
 *  3. A part of the day whose word IS one of the user's periods ("the evening
 *     before" with a period named Evening) → linked to that period: its
 *     start, and it follows a retime. Exact, case-insensitive, and the name
 *     must be in the user's words — never a period the time merely falls in.
 *  4. Any other part of the day → a custom time from `PART_OF_DAY_TIMES`
 *     (decision 12): afternoon 13:00, evening 18:00, night 20:00, midday
 *     12:00. The word must be the user's: a model that names a word the
 *     input lacks falls back to the one part-of-day word the input has.
 *  5. Anything else → the Default task time, as in 2.
 */

import { resolveTime, type TimeSetting } from '@/lib/anchor-times'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * Words that count a target back from a deadline. A relative target survives
 * only when the input has one — see `sanitizeTaskModelFields`. A counted day
 * or part of the day, then before/prior/ahead/earlier ("the evening before",
 * "the night before", "2 days before", "a week before", "the day prior"), or
 * "the day/morning/evening of" with nothing after it naming a date — "the
 * morning of the 12th" names a day (a fixed target), not the deadline's.
 */
export const RELATIVE_CUE =
  /\b(?:the|a|an|one|two|three|four|five|six|seven|\d+)\s+(?:days?|nights?|evenings?|mornings?|afternoons?|weeks?)\s+(?:before|prior|ahead|earlier)\b|\bthe\s+(?:day|morning|afternoon|evening|night)\s+of\b(?!\s+(?:the\s+)?\d|\s+(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i

/** A part of the day, as `relativeTargetTime` reads the model's word. */
type PartOfDay = 'morning' | 'midday' | 'afternoon' | 'evening' | 'night'

const PART_WORDS: Record<string, PartOfDay> = {
  morning: 'morning',
  noon: 'midday',
  midday: 'midday',
  lunch: 'midday',
  lunchtime: 'midday',
  afternoon: 'afternoon',
  evening: 'evening',
  night: 'night',
  tonight: 'night',
}

/**
 * DECISION 12: the custom time a part of the day stands for when no period
 * of the user's has its name. Morning is not here — it is the Default task
 * time (rule 2).
 */
export const PART_OF_DAY_TIMES: Record<Exclude<PartOfDay, 'morning'>, string> = {
  midday: '12:00',
  afternoon: '13:00',
  evening: '18:00',
  night: '20:00',
}

/** The clock window a part of the day covers (minutes from midnight; night wraps). */
const PART_WINDOWS: Record<PartOfDay, [number, number]> = {
  morning: [4 * 60, 12 * 60],
  midday: [11 * 60, 14 * 60],
  afternoon: [12 * 60, 18 * 60],
  evening: [16 * 60, 23 * 60],
  night: [18 * 60, 4 * 60],
}

/** A clock time in the words: "6pm", "6:30 pm", "830am", "18:00", "noon". */
const CLOCK_IN_WORDS =
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|\b\d{3,4}\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b(?:noon|midnight)\b/i

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** The model's three fields. */
export interface RelativeAnswer {
  target_days_before?: number | null
  target_time?: string | null
  target_period?: string | null
}

/** What the mapping reads: the owner's periods and their Default task time. */
export interface RelativeTimeContext {
  slots: readonly TimeSlot[]
  /** The Default task time as stored (`morning_time`, `morning_slot_id`). */
  defaultTime: TimeSetting
}

/** How the time was chosen — for the log and the tests. */
export type RelativeTimeSource = 'clock' | 'default' | 'period' | 'part_of_day'

export interface RelativeTime {
  /** HH:MM local. */
  time: string
  /** The period it follows, or null for a custom time. */
  slot_id: number | null
  source: RelativeTimeSource
}

function wordIn(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text)
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function inWindow(hhmm: string, part: PartOfDay): boolean {
  const [from, to] = PART_WINDOWS[part]
  const at = minutesOf(hhmm)
  return from < to ? at >= from && at < to : at >= from || at < to
}

/** The part-of-day word the input has, when it has exactly one kind. */
function onlyPartIn(text: string): PartOfDay | null {
  const found = new Set<PartOfDay>()
  for (const [word, part] of Object.entries(PART_WORDS)) if (wordIn(text, word)) found.add(part)
  return found.size === 1 ? [...found][0] : null
}

/** The Default task time, copied as it is: linked to its period, or custom (ruling 10). */
function defaultTimeOf(ctx: RelativeTimeContext): RelativeTime {
  const resolved = resolveTime(ctx.defaultTime, ctx.slots)
  return { time: resolved.time, slot_id: resolved.slot_id, source: 'default' }
}

/**
 * The relative target's time and period link from the model's answer — the
 * table in the header, in order. Pure; never asks.
 */
export function relativeTargetTime(
  answer: Pick<RelativeAnswer, 'target_time' | 'target_period'>,
  inputText: string,
  ctx: RelativeTimeContext,
): RelativeTime {
  const word = answer.target_period?.trim().toLowerCase() || null
  const part = word ? (PART_WORDS[word] ?? null) : null
  const clock = answer.target_time
  if (clock && HHMM.test(clock) && CLOCK_IN_WORDS.test(inputText)) {
    if (!part || inWindow(clock, part)) return { time: clock, slot_id: null, source: 'clock' }
  }
  if (!word || part === 'morning') return defaultTimeOf(ctx)
  const slot = ctx.slots.find((s) => s.label.trim().toLowerCase() === word)
  if (slot && wordIn(inputText, slot.label.trim())) {
    const linked = resolveTime({ time: slot.start_time, slot_id: slot.id }, ctx.slots)
    return { time: linked.time, slot_id: linked.slot_id, source: 'period' }
  }
  const said = word && wordIn(inputText, word) ? part : onlyPartIn(inputText)
  if (said === 'morning' || said === null) return defaultTimeOf(ctx)
  return { time: PART_OF_DAY_TIMES[said], slot_id: null, source: 'part_of_day' }
}
