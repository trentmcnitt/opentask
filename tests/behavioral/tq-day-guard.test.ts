/**
 * TQ-G01..: ONE DAY BOUNDARY, GUARDED (Trent, 2026-10-24). Like TM-G01
 * (tm-repeat-anchor.test.ts): a source scan that fails when code in src/
 * works out "today", an OpenTask day or a day boundary by its own arithmetic
 * instead of through the helpers in src/lib/opentask-day.ts
 * (`openTaskDayOf`, `openTaskDaySpan`, `dayStartMoment`, `latestRollover`,
 * `nextRollover`, `periodOpensAt`, `isLateNight`, `calendarDateOf`, …).
 *
 * WHAT IT CATCHES, per source line (comments skipped):
 * - A DAY FROM NOW: a day operation — `.startOf('day')`, `.endOf('day')`,
 *   `.toISODate()`, `toFormat('yyyy-MM-dd')` (or the deck / attempts date
 *   formats), `hasSame(…, 'day')`, `setHours(0`, `toISOString().split('T')`
 *   / `.slice(0, 10)` — on a line that reads the clock (`now`, `today`,
 *   `nowLocal`, `new Date()`, `Date.now()`, `DateTime.now()`, or a variable
 *   made from `now`).
 * - AN INSTANT'S CALENDAR DAY: a day operation on an instant turned local
 *   (`DateTime.fromJSDate(…)`, `fromMillis(…)`, `fromISO(…, { zone: 'utc' })
 *   .setZone(…)`) — the local date of a moment, which with a day start is
 *   not its OpenTask day.
 * - HAND-ROLLED DAY-START MINUTES: `% 1440`, or `parseHHMM(` of a rollover /
 *   day start, outside the helpers (`minutesIntoDay`).
 *
 * V2 ("OpenTask day everywhere" part 2, Trent 2026-10-26 — the audit found
 * eleven user-day entry points v1 missed, through helpers and weekdays):
 * the day operations include the date PARTS (a weekday, a week / month /
 * year, a date format, `calendarDateOf(`, a `.plus({ days` step); a line
 * starting with `.` is joined to the one it continues (a chained
 * `.startOf('day')` on its own line); and every `const` / `let` assigned
 * from the clock — a ternary included, or from a variable that was — is
 * tainted. The behaviour itself is pinned by TQ-LN
 * (tests/behavioral/tq-late-night.test.ts): every entry point answers at
 * 00:30 Monday (3:00 AM start) exactly as at 23:30 Sunday.
 *
 * "DAY STARTS AT" PR 2 (Trent, 2026-10-24: EVERYTHING uses the OpenTask
 * date) emptied the "PR 2 moves this" and "needs a ruling" entries: the Now
 * view, the Today pill, Upcoming, the horizon segments, check_in_day, the
 * roster, the overdue fallback, date labels, quota periods and the Quotas
 * page, decks, daily stats and History all go through opentask-day.ts now.
 * THE ALLOWLIST below is every such line left, each with its reason:
 * calendar dates on purpose (a date the user picked or said, read as a
 * date), calendar arithmetic on an OpenTask date already worked out, the
 * switch-off path, or not a user's day at all. The count is exact, and an
 * entry that no longer matches fails too, so the list stays true.
 *
 * TQ-G04 is structural: a type with `now: Date` and `timezone: string` must
 * carry `dayStart` / `rolloverTime` too (or be listed with its reason).
 *
 * TQ-G03 covers the CLIENT (and every default — v2: no `dayStart` /
 * `rolloverTime` default of any kind, and `'00:00'` only in its definition): the only places that choose
 * a day start are `dayBoundaryForUser` (server) and `useDayStart` (browser);
 * `CALENDAR_DAY_START` (midnight) appears nowhere else but the switch-off
 * paths listed there, and no function defaults its day start to midnight —
 * so a "today" in a component or hook can only come from the user's day.
 */
import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const CALENDAR =
  'a calendar date the user picked, typed or stored, read as a date (not "which day is it")'
const WORDS =
  'the user’s words, read on the calendar: enrichment’s "today" / "tomorrow" (A4 maps a late-night "tomorrow" to the coming day, `saidTomorrowBeforeRollover`); the deck floor it then meets is the OpenTask day (`deckOrTarget`)'
const ON_OPENTASK_DATE =
  'calendar arithmetic on today’s OpenTask date, already worked out (`openTaskToday`) — "plain calendar maths on that date"'
const SWITCH_OFF = "the switch-off path: the calendar day, which is CALENDAR_DAY_START's day"
const SHELVED = 'not a user day: shelved AI code (What’s Next / Insights / Quick Take), UTC dates'
const NOT_A_DAY = 'not a user day: a UTC date stamp (an export file name)'
// TQ-G01 v2's reasons ("OpenTask day everywhere" part 2, 2026-10-26).
const EXACT_MOMENT =
  'an exact moment shown as itself (its own date and time, as a tooltip or a dated line shows it) — not which day it is on'
const NEXT_INSTANT =
  'a clock time’s next instant (the next 9:00 AM, a slot’s next start, a wake time): the next moment, not a day'
const OCCURRENCE_DATE =
  'a rule’s or an occurrence’s own date (where a repeat, its relative target or its end falls, as the rule computes it)'
const DELIBERATE_CALENDAR = 'compared with the calendar date on purpose'
const WEEKDAY_HELPER =
  'a helper returning the weekday of the DateTime it is given — its callers own which day that is'
const NIGHT_HELPER =
  'the L9 night helper itself (src/lib/night-day.ts): a null day start reads the calendar (the switch off)'

/** `file: trimmed line` → [occurrences, reason]. */
const ALLOWLIST: Record<string, [number, string]> = {
  // ── Calendar arithmetic on an OpenTask date ─────────────────────────
  'src/components/OnDeckButton.tsx: const tomorrow = DateTime.fromISO(today).plus({ days: 1 }).toFormat(DECK_DAY_FORMAT)':
    [1, `${ON_OPENTASK_DATE} (the deck picker's tomorrow)`],
  'src/lib/deck-menu.ts: latestDay: today.minus({ days: 1 }).toFormat(DECK_DAY_FORMAT),': [
    1,
    `${ON_OPENTASK_DATE} (a passed deadline's deck limit: yesterday)`,
  ],

  // ── The user's words (enrichment) ───────────────────────────────────
  "src/core/ai/enrichment.ts: const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')":
    [2, `${WORDS} (resolveDeckDay); and dropUnstatedPastDates: ${CALENDAR}`],
  "src/core/ai/enrichment.ts: const settled = settleDeckDay(day.startOf('day'), inputText, today, opts, now)":
    [1, WORDS],
  "src/core/ai/enrichment.ts: day.hasSame(today, 'day') && !enrichment.rrule": [
    1,
    `${WORDS} (a date-only target said for today)`,
  ],
  "src/core/ai/enrichment.ts: if (day.hasSame(today, 'day') && !TODAY_CUE.test(inputText)) {": [
    1,
    `${WORDS} (a date-only target said for today)`,
  ],
  "src/core/ai/enrichment.ts: if (!target.hasSame(nowMinute, 'day')) return enrichment": [
    1,
    `${WORDS} (a time said for today that has passed)`,
  ],
  "src/core/ai/enrichment.ts: if (target.hasSame(nowLocal, 'day') && (namedClock || target >= nowLocal)) return enrichment":
    [1, `${WORDS} (resolveSameDayPast)`],

  // ── Calendar dates on purpose ───────────────────────────────────────
  "src/core/ai/enrichment.ts: return local !== null && local.startOf('day') < today": [1, CALENDAR],
  "src/lib/task-segments.ts: const day = DateTime.fromISO(occurrenceAt, { zone: 'utc' }).setZone(timezone).toISODate()!":
    [1, `${CALENDAR} (an occurrence's own date, for its rule time)`],
  "src/lib/task-segments.ts: return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toISODate()!":
    [1, `${CALENDAR} (localDateOf: a repeat end's date)`],
  "src/lib/task-segments.ts: DateTime.fromJSDate(d).setZone(timezone).startOf('day'),": [
    1,
    `${CALENDAR} (a rule's wait between deadlines)`,
  ],
  'src/core/recurrence/rule-shift.ts: const expected = DateTime.fromJSDate(b).setZone(timezone).plus({ days }).toISODate()':
    [1, `${CALENDAR} (a shifted rule's occurrence date)`],
  "src/core/db/migrate-deadline-leads.ts: const day = DateTime.fromISO(row.due_at!, { zone: 'utc' }).setZone(tz).toISODate()!":
    [1, `${CALENDAR} (a migration: the removed target's own date)`],
  "src/core/db/migrate-repeat-anchor.ts: const day = DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).plus({ days }).toISODate()!":
    [1, `${CALENDAR} (a migration)`],

  // ── The switch-off path ─────────────────────────────────────────────
  "src/lib/task-segments.ts: const wait = waitDays(deadlineDay, DateTime.fromJSDate(now).setZone(zone).startOf('day'))":
    [1, `${SWITCH_OFF} (the automatic target's lead, written only with the task queue off, A1)`],

  // ── Not a user's day ────────────────────────────────────────────────
  "src/app/api/ai/insights/results/route.ts: const todayUtc = new Date().toISOString().split('T')[0]":
    [1, SHELVED],
  "src/core/ai/whats-next.ts: const todayDate = new Date().toISOString().split('T')[0]": [
    1,
    SHELVED,
  ],
  "src/core/ai/quick-take.ts: const todayStart = now.startOf('day')": [1, SHELVED],
  "src/core/ai/quick-take.ts: const todayEnd = now.endOf('day')": [1, SHELVED],
  "src/core/ai/quick-take.ts: const diffDays = Math.floor(dt.startOf('day').diff(now.startOf('day'), 'days').days)":
    [1, SHELVED],
  'src/app/api/export/route.ts: const today = new Date().toISOString().slice(0, 10)': [
    1,
    NOT_A_DAY,
  ],

  // ── Calendar arithmetic on an OpenTask date (TQ-G01 v2) ──
  'src/app/history/page.tsx: onClick={() => setDate(DateTime.fromISO(date).minus({ days: 1 }).toISODate()!)}':
    [1, `${ON_OPENTASK_DATE} (History's previous day: the picked OpenTask date − 1)`],
  'src/app/history/page.tsx: onClick={() => setDate(DateTime.fromISO(date).plus({ days: 1 }).toISODate()!)}':
    [1, `${ON_OPENTASK_DATE} (History's next day: the picked OpenTask date + 1)`],
  "src/lib/history-time-label.ts: const weekday = `${timedDay(n).toFormat('cccc')}${night}`": [
    1,
    `${ON_OPENTASK_DATE} (an entry's weekday beside its time: in its night the OpenTask day, else its own date — timedDay, from nightDay)`,
  ],
  'src/core/ai/enrichment.ts: const base = today.weekday === 7 ? today.minus({ days: 1 }) : saturday':
    [1, `${ON_OPENTASK_DATE} ("this weekend": weekendDeckDay is given the OpenTask today)`],
  'src/core/ai/enrichment.ts: const day = base.plus({ days: named[0] - 6 })': [
    1,
    `${ON_OPENTASK_DATE} ("this weekend" with Saturday or Sunday named)`,
  ],
  'src/core/ai/enrichment.ts: if (today.weekday >= 6) return today': [
    1,
    `${ON_OPENTASK_DATE} (thisWeekendDay, on the OpenTask today)`,
  ],
  'src/core/ai/enrichment.ts: return today.plus({ days: target - today.weekday })': [
    1,
    `${ON_OPENTASK_DATE} (thisWeekendDay, on the OpenTask today)`,
  ],
  'src/core/ai/enrichment.ts: return { ...enrichment, due_at: null, on_deck_day: settled.deck.toISODate()! }':
    [1, `${ON_OPENTASK_DATE} ("this weekend"'s deck, settled on the OpenTask today)`],
  'src/core/ai/enrichment.ts: ? RRULE_DAYS[day.weekday - 1]': [
    1,
    `${ON_OPENTASK_DATE} (pinUnnamedDay: the OpenTask today, or the start the user named)`,
  ],
  "src/core/ai/prompts.ts: const words = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {":
    [1, `${ON_OPENTASK_DATE} (userDayLine: the OpenTask date as words)`],
  "src/core/notifications/deadline-nags.ts: return day <= shiftDay(today, 6, timezone) ? d.toFormat('ccc') : d.toFormat('LLL d')":
    [1, `${ON_OPENTASK_DATE} (the deadline nag's day name: OpenTask days)`],
  "src/core/tasks/task-segments.ts: const words = DateTime.fromISO(target, { zone: timezone }).toFormat('ccc LLL d')":
    [1, `${ON_OPENTASK_DATE} (the defer-lead summary: the lead day picked)`],
  'src/lib/deck-menu.ts: const day = d.toFormat(DECK_DAY_FORMAT)': [
    2,
    `${ON_OPENTASK_DATE} (the deck menu: days on from the OpenTask today)`,
  ],
  'src/lib/deck-menu.ts: const d = today.plus({ days: n })': [
    2,
    `${ON_OPENTASK_DATE} (the deck menu: days on from the OpenTask today)`,
  ],
  "src/lib/deck-menu.ts: const name = n === 1 ? 'Tomorrow' : d.toFormat('cccc')": [
    1,
    `${ON_OPENTASK_DATE} (the deck menu: days on from the OpenTask today)`,
  ],
  'src/lib/deck-menu.ts: const isCheckIn = d.weekday === checkInDay': [
    1,
    `${ON_OPENTASK_DATE} (the deck menu: days on from the OpenTask today)`,
  ],
  'src/lib/deck-menu.ts: const next = today.plus({ days: 7 })': [
    1,
    `${ON_OPENTASK_DATE} (the deck menu: days on from the OpenTask today)`,
  ],
  "src/lib/deck-menu.ts: items.push(item(next, `${next.toFormat('ccc LLL d')} \u00b7 ${CHECK_IN_MARK}`))":
    [1, `${ON_OPENTASK_DATE} (the deck menu: days on from the OpenTask today)`],
  "src/lib/deck-menu.ts: : `On deck ${day.toFormat('ccc')}`": [
    1,
    `${ON_OPENTASK_DATE} (the deck menu: days on from the OpenTask today)`,
  ],
  "src/lib/deck-menu.ts: days.push({ label: n === 1 ? 'Tomorrow' : d.toFormat('cccc'), day })": [
    1,
    `${ON_OPENTASK_DATE} (the deck menu: days on from the OpenTask today)`,
  ],
  "src/lib/deck-menu.ts: days.push({ label: lastDay.toFormat('ccc LLL d'), day: last })": [
    1,
    `${ON_OPENTASK_DATE} (the deck menu: days on from the OpenTask today)`,
  ],
  "src/lib/editor-target-labels.ts: const day = DateTime.fromISO(line.from, { zone: timezone }).toFormat('ccc LLL d')":
    [1, `${ON_OPENTASK_DATE} (a lead day, lead_from)`],
  "src/lib/editor-target-labels.ts: const fmt = (day: string) => DateTime.fromISO(day, { zone: timezone }).toFormat('ccc LLL d')":
    [1, `${ON_OPENTASK_DATE} (a deck / lead day as words)`],
  'src/lib/every-time.ts: return RULE_DAYS[openTaskLocalDay(ctx.now, ctx.timezone, ctx.dayStart).weekday - 1]':
    [1, `${ON_OPENTASK_DATE} (every-time's weekday default: openTaskLocalDay)`],
  "src/lib/just-added.ts: if (+deck === +today.plus({ days: 1 })) return 'On deck tomorrow'": [
    1,
    `${ON_OPENTASK_DATE} ("On deck tomorrow": the OpenTask today + 1)`,
  ],
  "src/lib/quick-select-dates.ts: return nightDay(date, timezone, dayStart, now).day.toFormat('ccc')":
    [1, `${ON_OPENTASK_DATE} (getDayLabel's weekday: the OpenTask day, from nightDay)`],
  'src/lib/task-segments.ts: return first.plus({ days: (checkInDay - first.weekday + 7) % 7 })': [
    1,
    `${ON_OPENTASK_DATE} (a month's first check-in day)`,
  ],
  'src/lib/task-segments.ts: return today.minus({ days: (today.weekday - checkInDay + 7) % 7 })': [
    1,
    `${ON_OPENTASK_DATE} (latestSegmentDay: given the OpenTask today)`,
  ],
  "src/lib/task-segments.ts: DateTime.fromISO(stored.countedThrough, { zone: timezone }).startOf('day').plus({ days: 1 }),":
    [1, `${ON_OPENTASK_DATE} (attempts: the day after the stored checkpoint, an OpenTask date)`],
  'src/lib/task-segments.ts: countedThrough: end.toFormat(ATTEMPTS_DATE_FORMAT),': [
    1,
    `${ON_OPENTASK_DATE} (attempts' checkpoint)`,
  ],
  'src/lib/task-segments.ts: return DateTime.max(counted, yesterday)!.toFormat(ATTEMPTS_DATE_FORMAT)':
    [1, `${ON_OPENTASK_DATE} (the put-back's checkpoint)`],
  'src/lib/task-segments.ts: return DateTime.fromISO(day, { zone: timezone }).plus({ days }).toFormat(LEAD_DAY_FORMAT)':
    [1, `${ON_OPENTASK_DATE} (shiftDay: calendar maths on a date)`],
  'src/lib/task-segments.ts: const earliest = setDay.plus({ days: 1 })': [
    1,
    `${ON_OPENTASK_DATE} (upcomingDays: the OpenTask day after the set day)`,
  ],
  "src/lib/task-segments.ts: target = tomorrow ? 'On deck tomorrow' : `On deck ${deck.toFormat('ccc LLL d')}`":
    [1, `${ON_OPENTASK_DATE} (a deck day as words)`],
  "src/lib/task-segments.ts: return d.isValid ? d.startOf('day') : null": [
    1,
    `${ON_OPENTASK_DATE} (parseDeckDay: a stored deck day)`,
  ],
  "src/lib/task-segments.ts: if (+d === +today.plus({ days: 1 })) return 'tomorrow'": [
    1,
    `${ON_OPENTASK_DATE} (deckDayWords: the OpenTask today + 1)`,
  ],
  "src/lib/task-segments.ts: return d.toFormat('ccc LLL d')": [
    1,
    `${ON_OPENTASK_DATE} (deckDayWords)`,
  ],
  // ── An exact moment, shown as such (TQ-G01 v2) ──
  "src/components/quick-panel/BeforeDeadlineBlock.tsx: const when = DateTime.fromISO(at, { zone: 'utc' }).setZone(timezone).toFormat('ccc LLL d, h:mm a')":
    [1, `${EXACT_MOMENT} (the deadline's exact moment)`],
  "src/lib/format-date.ts: const dateAndTime = `${due.toLocaleDateString('en-US', { timeZone: timezone, month: 'short', day: 'numeric' })} ${time}`":
    [1, `${EXACT_MOMENT} (an overdue target's date + time)`],
  "src/lib/task-segments.ts: : DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('ccc LLL d')":
    [
      1,
      `${EXACT_MOMENT} (Upcoming's two dates — the target and the deadline as dated, 2026-10-12 — outside the night: a night moment goes through isLateNight / nightWords)`,
    ],
  "src/lib/task-segments.ts: return `${day.toFormat('ccc')}${NIGHT_SUFFIX} ${day.toFormat('LLL d')}`":
    [
      1,
      `${ON_OPENTASK_DATE} (nightWords: Upcoming's "Thu night Oct 29", the OpenTask date of a night moment)`,
    ],
  // ── Calendar dates on purpose (TQ-G01 v2) ──
  "src/core/ai/enrichment.ts: return local.toFormat('yyyy-MM-dd')": [
    1,
    `${CALENDAR} (timelessDay: the model's date at the default time read as a day; flagged by a same-named clock variable elsewhere in the file)`,
  ],
  'src/core/ai/enrichment.ts: const dow = getDayOfWeek(local)': [
    1,
    `${CALENDAR} (a date the model gave, aligned to its rule's weekday)`,
  ],
  'src/core/ai/enrichment.ts: return local.plus({ days: minDistance })': [
    1,
    `${CALENDAR} (a date the model gave, aligned to its rule's weekday)`,
  ],
  "src/core/tasks/skip-until.ts: return DateTime.fromFormat(until, 'yyyy-MM-dd', { zone: 'utc' }).toFormat('ccc, LLL d')":
    [1, `${CALENDAR} (the until date the user picked, as words)`],
  // ── The user's words (TQ-G01 v2) ──
  "src/core/ai/enrichment.ts: const onDeck = deck.toFormat('yyyy-MM-dd')": [1, WORDS],
  "src/core/ai/enrichment.ts: if (!at || !at.hasSame(nowLocal.plus({ days: 1 }), 'day')) return value":
    [1, `${WORDS} (resolveEarlyTomorrow, A4)`],
  'src/core/ai/enrichment.ts: const tomorrow = today.plus({ days: 1 })': [
    1,
    `${WORDS} (settleDeckDay's "tomorrow")`,
  ],
  'src/core/ai/enrichment.ts: const todayNamed = saysToday || WEEKDAY_WORDS[today.weekday].test(inputText) || early':
    [1, `${WORDS} (a weekday said that is today's calendar weekday)`],
  "src/core/ai/enrichment.ts: local.hasSame(nowLocal.plus({ days: 1 }), 'day') &&": [
    1,
    `${WORDS} (a "tomorrow" said)`,
  ],
  'src/core/ai/enrichment.ts: const next = toLocalIso(target.plus({ days: 1 }), value)': [
    1,
    `${WORDS} (resolveSameDayPast: a time said for today that has passed → tomorrow)`,
  ],
  // ── A clock time's next instant (TQ-G01 v2) ──
  'src/core/ai/enrichment.ts: if (next <= nowLocal) next = next.plus({ days: 1 })': [
    1,
    `${NEXT_INSTANT} (resolveBareTime: a time with no day is its next occurrence)`,
  ],
  'src/core/notifications/widget-push.ts: if (wakeAt <= local) wakeAt = local.plus({ days: 1 }).set(wakeClock)':
    [1, `${NEXT_INSTANT} (a widget's next wake time)`],
  'src/lib/quick-select-dates.ts: }).formatToParts(reference)': [
    1,
    `${NEXT_INSTANT} (snapToNextPreset: a passed preset's next day)`,
  ],
  'src/lib/time-slot-assign.ts: return (today > local ? today : today.plus({ days: 1 })).toUTC().toISO()!':
    [1, `${NEXT_INSTANT} (a slot's next start)`],
  // ── Compared with the calendar on purpose (TQ-G01 v2) ──
  "src/core/ai/prompts.ts: if (day === calendarDateOf(now, timezone)) return ''": [
    1,
    `${DELIBERATE_CALENDAR} (userDayLine: the line is written only when the OpenTask day is not the calendar date)`,
  ],
  'src/core/tasks/task-rollover.ts: calendarDateOf(new Date(task.due_at!), timezone) === openTaskDayOf(m, timezone, rolloverTime) &&':
    [
      1,
      `${DELIBERATE_CALENDAR} (the early-morning pick: a target's calendar date against the OpenTask day, isEarlyMorningPick's rule)`,
    ],
  // ── Shelved (TQ-G01 v2) ──
  'src/core/ai/quick-take.ts: const weekStart = startOfWeek(now, firstDay)': [1, SHELVED],
  'src/core/ai/quick-take.ts: if (diffDays > 1 && diffDays <= 6) return dt.toFormat(\'ccc\') // "Wed"':
    [1, SHELVED],
  "src/core/ai/quick-take.ts: const currentTime = DateTime.now().setZone(timezone).toFormat('ccc, LLL d, h:mm a')":
    [1, SHELVED],
  // ── Helpers (TQ-G01 v2) ──
  'src/core/recurrence/timezone.ts: export function getDayOfWeek(dt: DateTime): number {': [
    1,
    `${WEEKDAY_HELPER} (getDayOfWeek)`,
  ],
  'src/core/recurrence/timezone.ts: return dt.weekday - 1': [1, `${WEEKDAY_HELPER} (getDayOfWeek)`],
  'src/lib/night-day.ts: const today = dayStart ? openTaskDayOf(now, timezone, dayStart) : calendarDateOf(now, timezone)':
    [1, `${NIGHT_HELPER}`],
  // ── Not a user's day (TQ-G01 v2) ──
  "src/core/stats/purge.ts: const cutoffDateStr = cutoffDate.toISOString().split('T')[0]": [
    1,
    'not a user day: a retention cutoff (UTC date stamp)',
  ],
  // ── A rule's or an occurrence's own date (TQ-G01 v2) ──
  "src/core/tasks/repeat-schedule.ts: const occurrenceDay = DateTime.fromISO(check.occurrenceAt, { zone: 'utc' }).setZone(timezone).toISODate()!":
    [
      1,
      `${OCCURRENCE_DATE} (repeat until: not before the occurrence's own date — the end is judged on calendar dates, localDateOf)`,
    ],
  "src/core/tasks/skip-until.ts: const dayAfter = DateTime.fromISO(end.repeat_until, { zone: timezone }).startOf('day').plus({ days: 1 }).toJSDate()":
    [1, `${OCCURRENCE_DATE} (a series' repeat_until end, as repeatStep reads it — localDateOf)`],
  "src/core/tasks/skip-until.ts: return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('ccc, LLL d')":
    [1, `${OCCURRENCE_DATE} (skip until's landing, as its own date)`],
  "src/lib/editor-target-labels.ts: const day = occurrence.toFormat('ccc LLL d')": [
    1,
    OCCURRENCE_DATE,
  ],
  "src/lib/editor-target-labels.ts: return targetDay.hasSame(occurrence, 'day') ? day : `${day} (deadline)`":
    [1, OCCURRENCE_DATE],
  'src/lib/task-segments.ts: const day = deadlineDay.minus({ days: lead.days_before }).toISODate()!':
    [1, `${OCCURRENCE_DATE} (a lead day N days before the deadline's own date)`],
  "src/lib/task-segments.ts: const day = deadline.startOf('day').minus({ days: relative.days_before })":
    [1, `${OCCURRENCE_DATE} (a relative target: N days before its deadline's own date)`],
  'src/lib/task-segments.ts: const target = localMoment(day.toISODate()!, relative.time, timezone)':
    [1, `${OCCURRENCE_DATE} (a relative target's moment)`],
  "src/lib/task-segments.ts: return DateTime.fromISO(targetAt, { zone: 'utc' }).setZone(timezone).plus({ days: daysBefore }).toISODate()!":
    [1, `${OCCURRENCE_DATE} (a deadline from its target and offset)`],
  "src/lib/task-segments.ts: days_before: waitDays(deadline.startOf('day'), target.startOf('day')),":
    [1, `${OCCURRENCE_DATE} (the offset between a deadline and a target)`],
  "src/lib/task-segments.ts: wait = Math.min(wait, waitDays(days[i].startOf('day'), days[i - 1].startOf('day')))":
    [1, `${OCCURRENCE_DATE} (a rule's wait between occurrences)`],
  'src/lib/task-segments.ts: : DateTime.fromISO(calendarDateOf(at, ctx.timezone), { zone: ctx.timezone })':
    [
      1,
      `${DELIBERATE_CALENDAR} ("Morning of the deadline" out of the night: the morning of the deadline's own date, Trent 2026-10-26 — with an 11 PM start a Tue 23:47 deadline's is Tue 9:00)`,
    ],
  "src/lib/task-segments.ts: const deadlineDay = local.startOf('day')": [
    1,
    `${OCCURRENCE_DATE} (autoTargetAt: the automatic target counts its lead days back from the deadline's own date — stored by resolveTarget with the task queue off (A1), and also computed whatever the switch says for the AI task summaries' implied target, task-summaries.ts, and by migrate-deadline-targets.ts)`,
  ],
  // ── The switch-off path (TQ-G01 v2) ──
  'src/lib/task-segments.ts: return rolloverTime ? openTaskDayOf(now, timezone, rolloverTime) : calendarDateOf(now, timezone)':
    [1, `${SWITCH_OFF} (openTaskToday with a null rollover time)`],
}

/**
 * TQ-G03: the files where `CALENDAR_DAY_START` (midnight as a day start) may
 * appear in code, each with its reason — everywhere else a day start comes
 * from the user (`dayBoundaryForUser` / `useDayStart`).
 */
const CALENDAR_DAY_START_FILES: Record<string, string> = {
  'src/lib/opentask-day.ts': 'its definition',
  'src/core/tasks/rollover-time.ts':
    '`dayBoundaryForUser`: the server’s one rule (the day start with the task queue on, midnight off)',
  'src/lib/browser-day-start.ts':
    '`browserDayStart`: the browser’s one rule (`useDayStart`), the same as `dayBoundaryForUser`, and what the page draws with while the day start is unknown',
  'src/lib/task-segments.ts':
    'a null rollover time (the switch off) read as calendar days: attempts, the put-back, the deadlines page’s day; and `followingOccurrence`’s step from an OCCURRENCE (not a completion): a from_completion rule steps the occurrence’s own date, which for an occurrence at the rule’s time is the same answer under every day start',
  'src/core/tasks/read.ts':
    'the served quota period of a row whose owner rollover time is null (the switch off)',
}
/** The helpers themselves (and `minutesIntoDay`'s home beside the slot pager). */
const HELPERS = new Set(['src/lib/opentask-day.ts'])
const MINUTE_HELPERS = new Set(['src/lib/opentask-day.ts', 'src/lib/time-slot-assign.ts'])

/**
 * A DAY OPERATION (TQ-G01 v2, "OpenTask day everywhere" part 2, 2026-10-26):
 * the date parts as well as the day — a weekday (`.weekday`, `weekdayOf(`,
 * `getDayOfWeek(`, `.getDay()`, `toFormat('ccc…'` / `'EEE…'`), a date
 * format (`toLocaleDateString(`, `formatToParts(`), the week / month / year
 * (`startOf` / `endOf`, `hasSame`, `startOfWeek(`), a calendar date
 * (`calendarDateOf(`), and a day step (`.plus({ days`) on a line that reads
 * the clock. v1 saw only `startOf('day')`-style ops, so a weekday from now
 * (every-time's default day, enrichment's pin) slipped past it.
 */
const DAY_OP = new RegExp(
  [
    String.raw`\.startOf\(\s*'(day|week|month|year)'`,
    String.raw`\.endOf\(\s*'(day|week|month|year)'`,
    String.raw`\.toISODate\(\)`,
    String.raw`toFormat\(\s*('yyyy-MM-dd'|DECK_DAY_FORMAT|ATTEMPTS_DATE_FORMAT|LEAD_DAY_FORMAT|'c{3,4}|'E{3,4})`,
    String.raw`setHours\(\s*0`,
    String.raw`toISOString\(\)\s*\.(split\(\s*'T'|slice\(\s*0\s*,\s*10)`,
    String.raw`toLocaleDateString\(`,
    String.raw`formatToParts\(`,
    String.raw`hasSame\(.*'(day|week|month|year)'\s*\)`,
    String.raw`\.weekday\b`,
    String.raw`\bweekdayOf\(`,
    String.raw`\bgetDayOfWeek\(`,
    String.raw`\.getDay\(\)`,
    String.raw`\bcalendarDateOf\(`,
    String.raw`\bstartOfWeek\(`,
    String.raw`\.plus\(\s*\{\s*days\b`,
  ].join('|'),
)
const READS_CLOCK =
  /\b(now|localNow|today|userNow|nowLocal|nowDt|nowMinute)\b|Date\.now\(\)|DateTime\.(now|local)\(\)|new Date\(\)/
const INSTANT_TO_LOCAL = /fromJSDate\(|fromMillis\(|\{\s*zone:\s*'utc'\s*\}\)\.setZone\(/
const MINUTES = /%\s*1440\b|parseHHMM\(\s*(rolloverTime|dayStart|rollover)\b/
/** `const x = <expr>` / `let x = <expr>`: the name and the expression (ternaries included). */
const ASSIGN = /^(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(.+)$/

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return files(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })
}

/**
 * A file's code as logical lines: comments blanked, and a line that starts
 * with `.` (a chained call on its own line — `.startOf('day')` under
 * `DateTime.fromJSDate(now)`) joined to the line it continues.
 */
function logicalLines(text: string): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) {
      lines.push('')
      continue
    }
    const last = lines.length - 1
    if (line.startsWith('.') && last >= 0 && lines[last]) lines[last] += line
    else lines.push(line)
  }
  return lines
}

/**
 * The file's CLOCK-TAINTED variables: every `const` / `let` assigned from an
 * expression that reads the clock — `now`, `DateTime.now()`, a ternary on
 * `now` — or from one already tainted (to a fixed point). v1 knew only
 * `DateTime.fromJSDate(now)` and `DateTime.now()`.
 */
function taintedVars(lines: string[]): RegExp[] {
  const assigns = lines.flatMap((l) => {
    const m = l.match(ASSIGN)
    return m ? [{ name: m[1], expr: m[2] }] : []
  })
  const tainted = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const { name, expr } of assigns) {
      if (tainted.has(name)) continue
      const reads =
        READS_CLOCK.test(expr) || [...tainted].some((v) => new RegExp(`\\b${v}\\b`).test(expr))
      if (reads) {
        tainted.add(name)
        grew = true
      }
    }
  }
  return [...tainted].map((v) => new RegExp(`\\b${v}\\b`))
}

/** Every flagged line in src/, as `file: trimmed line`, with how often it occurs. */
function flagged(): Map<string, number> {
  const root = process.cwd()
  const found = new Map<string, number>()
  for (const f of files(path.join(root, 'src'))) {
    const rel = path.relative(root, f)
    const lines = logicalLines(fs.readFileSync(f, 'utf8'))
    const nowVars = taintedVars(lines)
    for (const line of lines) {
      if (!line) continue
      const dayOp =
        !HELPERS.has(rel) &&
        DAY_OP.test(line) &&
        (READS_CLOCK.test(line) || INSTANT_TO_LOCAL.test(line) || nowVars.some((v) => v.test(line)))
      const minutes = !MINUTE_HELPERS.has(rel) && MINUTES.test(line)
      if (!dayOp && !minutes) continue
      const key = `${rel}: ${line}`
      found.set(key, (found.get(key) ?? 0) + 1)
    }
  }
  return found
}

describe('TQ-G01: every "today" / OpenTask day / day boundary in src/ goes through opentask-day.ts', () => {
  const found = flagged()

  test('TQ-G01: nothing outside the allowlist works out a day by its own arithmetic', () => {
    const offenders = [...found.keys()].filter((key) => !(key in ALLOWLIST))
    expect(offenders).toEqual([])
  })

  test('TQ-G01b: the allowlist is exact — every entry still occurs, as often as it says', () => {
    const stale = Object.entries(ALLOWLIST)
      .filter(([key, [count]]) => found.get(key) !== count)
      .map(([key, [count]]) => `${key} (listed ${count}, found ${found.get(key) ?? 0})`)
    expect(stale).toEqual([])
  })

  test('TQ-G01c: every entry gives its reason', () => {
    for (const [key, [, reason]] of Object.entries(ALLOWLIST)) {
      expect(reason.length, key).toBeGreaterThan(10)
    }
  })
})

describe('TQ-G02: the old day-start fallbacks are gone', () => {
  const root = process.cwd()
  const read = (f: string) => fs.readFileSync(f, 'utf8')
  const scan = (dirs: string[], pattern: RegExp, ext = /\.(tsx?|swift)$/) =>
    dirs
      .flatMap((d) => {
        const dir = path.join(root, d)
        if (!fs.existsSync(dir)) return []
        const walk = (p: string): string[] =>
          fs.readdirSync(p, { withFileTypes: true }).flatMap((e) => {
            const q = path.join(p, e.name)
            if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(q)
            return ext.test(e.name) ? [q] : []
          })
        return walk(dir)
      })
      .filter((f) => pattern.test(read(f)))
      .map((f) => path.relative(root, f))

  test('TQ-G02: no rolloverMoment (its semantics were ambiguous — dayStartMoment) and no rolloverTimeOf (one rollover source)', () => {
    expect(scan(['src'], /\brolloverMoment\(|\brolloverTimeOf\(/)).toEqual([])
  })

  test('TQ-G02b: "first period" is not the day start any more — no first_period / day_start_first_period', () => {
    expect(scan(['src', 'ios', 'macos'], /\bfirst_period\b|day_start_first_period/)).toEqual([])
    expect(read(path.join(root, 'docs/openapi.yaml'))).not.toMatch(/day_start_first_period/)
  })

  test('TQ-G02c: the attempts SQL has no first-period or Morning fallback', () => {
    const sql = read(path.join(root, 'src/core/tasks/read.ts'))
    expect(sql).not.toMatch(/MIN\(start_time\)/)
    expect(sql).not.toMatch(/SELECT morning_time FROM users/)
  })
})

describe('TQ-G03: the user chooses the day — no default midnight, on the server or in the browser', () => {
  const root = process.cwd()
  const codeLines = (f: string) =>
    fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !(l.startsWith('*') || l.startsWith('//') || l.startsWith('/*')))
  const srcFiles = files(path.join(root, 'src')).map((f) => path.relative(root, f))

  test('TQ-G03: CALENDAR_DAY_START appears in code only where midnight is the rule (dayBoundaryForUser, useDayStart, the switch-off paths)', () => {
    const using = srcFiles.filter((f) =>
      codeLines(path.join(root, f)).some((l) => /\bCALENDAR_DAY_START\b/.test(l)),
    )
    expect(using.sort()).toEqual(Object.keys(CALENDAR_DAY_START_FILES).sort())
    for (const reason of Object.values(CALENDAR_DAY_START_FILES)) {
      expect(reason.length).toBeGreaterThan(10)
    }
  })

  test('TQ-G03b: no function defaults its day start to midnight — every caller passes the user’s', () => {
    const defaults = srcFiles.flatMap((f) =>
      codeLines(path.join(root, f))
        .filter(
          (l) => /(?<![=!<>])=\s*CALENDAR_DAY_START\s*[,)]/.test(l) && !/^(const|let)\b/.test(l),
        )
        .map((l) => `${f}: ${l}`),
    )
    expect(defaults).toEqual([])
  })

  // TQ-G03b v2 ("OpenTask day everywhere" part 2, 2026-10-26): no DEFAULT
  // day start of any kind — `dayStart: string = '00:00'` (naturalSlotIndex
  // had one) or `rolloverTime: string | null = null` (the calendar, five
  // functions had one) — anywhere in src/. A caller that forgets it gets a
  // type error, not midnight. The allowlist is exact (key + count).
  const DAY_START_DEFAULT = /\b(dayStart|rolloverTime)\??\s*:\s*string(\s*\|\s*null)?\s*=(?!=)/
  const DAY_START_DEFAULT_ALLOWLIST: Record<string, [number, string]> = {}
  test('TQ-G03b2: no parameter or field gives a day start a default value (exact allowlist)', () => {
    const found = new Map<string, number>()
    for (const f of srcFiles) {
      for (const l of codeLines(path.join(root, f)).filter((x) => DAY_START_DEFAULT.test(x))) {
        found.set(`${f}: ${l}`, (found.get(`${f}: ${l}`) ?? 0) + 1)
      }
    }
    const listed = Object.fromEntries(
      Object.entries(DAY_START_DEFAULT_ALLOWLIST).map(([k, [n]]) => [k, n]),
    )
    expect(Object.fromEntries(found)).toEqual(listed)
  })

  // The MIDNIGHT LITERAL: `'00:00'` in code anywhere in src/ is the day
  // start's definition only — every other midnight is `CALENDAR_DAY_START`
  // (whose files TQ-G03 lists), so it can be found. Exact (key + count).
  const MIDNIGHT_LITERAL_ALLOWLIST: Record<string, [number, string]> = {
    "src/lib/opentask-day.ts: export const CALENDAR_DAY_START = '00:00'": [
      1,
      'its definition: midnight as a day start',
    ],
  }
  test("TQ-G03b3: '00:00' appears in src/ code only where the allowlist says (exact)", () => {
    const found = new Map<string, number>()
    for (const f of srcFiles) {
      for (const l of codeLines(path.join(root, f)).filter((x) => /['"]00:00['"]/.test(x))) {
        found.set(`${f}: ${l}`, (found.get(`${f}: ${l}`) ?? 0) + 1)
      }
    }
    const listed = Object.fromEntries(
      Object.entries(MIDNIGHT_LITERAL_ALLOWLIST).map(([k, [n]]) => [k, n]),
    )
    expect(Object.fromEntries(found)).toEqual(listed)
    for (const [key, [, reason]] of Object.entries({
      ...MIDNIGHT_LITERAL_ALLOWLIST,
      ...DAY_START_DEFAULT_ALLOWLIST,
    })) {
      expect(reason.length, key).toBeGreaterThan(10)
    }
  })

  test('TQ-G03c: the browser reads its day start from useDayStart — no client file asks the server helpers or picks midnight', () => {
    // v2 (part 2, 2026-10-26): src/lib too — the pure helpers the browser
    // runs — but for the day's own helpers and the files TQ-G03 lists.
    const libExempt = new Set([
      'src/lib/opentask-day.ts',
      'src/lib/browser-day-start.ts',
      ...Object.keys(CALENDAR_DAY_START_FILES),
    ])
    const client = srcFiles.filter(
      (f) =>
        (f.startsWith('src/components/') ||
          f.startsWith('src/hooks/') ||
          (f.startsWith('src/lib/') && !libExempt.has(f)) ||
          (f.startsWith('src/app/') && !f.startsWith('src/app/api/'))) &&
        f !== 'src/components/PreferencesProvider.tsx',
    )
    const offenders = client.filter((f) =>
      codeLines(path.join(root, f)).some((l) =>
        /\b(CALENDAR_DAY_START|dayBoundaryForUser|rolloverTimeForUser)\b|['"]00:00['"]/.test(l),
      ),
    )
    expect(offenders).toEqual([])
  })
})

/**
 * TQ-G04 (structural, "OpenTask day everywhere" part 2, 2026-10-26): a type
 * that carries a moment (`now: Date`) and a zone (`timezone: string`) is
 * asking "which day is it" — so it must carry the user's day too
 * (`dayStart` / `rolloverTime`). `EveryTimeContext` had `now` and `timezone`
 * and no day start, so every-time's weekday default read the calendar. Every
 * interface and object type in src/ (exported or not); the allowlist is
 * exact, each with its reason.
 */
describe('TQ-G04: a type with now + timezone carries the day start', () => {
  const root = process.cwd()
  const NOW_TZ_ALLOWLIST: Record<string, string> = {
    'src/components/DueDateFilterBar.tsx: DueDateFilterBarProps':
      'component props: the component reads the user’s day itself (`useDayStart`) for its buckets',
    'src/components/ProjectFilterBar.tsx: ProjectFilterBarProps':
      'component props: the component reads the user’s day itself (`useDayStart`) for its counts',
    'src/hooks/useFilterState.ts: UseFilterStateOptions':
      'a hook’s options: the hook reads the user’s day itself (`useDayStart`) and passes it to `applyTaskFilters`',
    'src/core/tasks/deck.ts: DeckTasksOptions':
      'server options with `userId`: `deckTasks` reads the owner’s day (`dayBoundaryForUser(opts.userId)`)',
  }

  function nowTimezoneTypes(): Map<string, boolean> {
    const out = new Map<string, boolean>()
    for (const f of files(path.join(root, 'src'))) {
      const text = fs.readFileSync(f, 'utf8')
      const head = /(?:export\s+)?(?:interface|type)\s+(\w+)[^{=;]*(?:=\s*)?\{/g
      let m: RegExpExecArray | null
      while ((m = head.exec(text))) {
        let i = m.index + m[0].length
        let depth = 1
        while (depth && i < text.length) {
          if (text[i] === '{') depth++
          else if (text[i] === '}') depth--
          i++
        }
        const body = text
          .slice(m.index + m[0].length, i - 1)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
        if (/\bnow\??\s*:\s*Date\b/.test(body) && /\btimezone\??\s*:\s*string\b/.test(body)) {
          out.set(
            `${path.relative(root, f)}: ${m[1]}`,
            /\b(dayStart|rolloverTime)\??\s*:/.test(body),
          )
        }
      }
    }
    return out
  }

  test('TQ-G04: every type with now: Date and timezone: string has dayStart or rolloverTime (or a listed reason)', () => {
    const missing = [...nowTimezoneTypes()]
      .filter(([key, has]) => !has && !(key in NOW_TZ_ALLOWLIST))
      .map(([key]) => key)
    expect(missing).toEqual([])
  })

  test('TQ-G04b: the allowlist is exact and reasoned', () => {
    const types = nowTimezoneTypes()
    for (const [key, reason] of Object.entries(NOW_TZ_ALLOWLIST)) {
      expect(types.get(key), key).toBe(false)
      expect(reason.length, key).toBeGreaterThan(10)
    }
  })
})
