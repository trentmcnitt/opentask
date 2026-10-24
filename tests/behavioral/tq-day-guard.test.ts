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
 *   formats), `setHours(0`, `toISOString().split('T')` / `.slice(0, 10)` —
 *   on a line that reads the clock (`now`, `today`, `new Date()`,
 *   `Date.now()`, `DateTime.now()`, or a variable made from `now`).
 * - AN INSTANT'S CALENDAR DAY: a day operation on an instant turned local
 *   (`DateTime.fromJSDate(…)`, `fromMillis(…)`, `fromISO(…, { zone: 'utc' })
 *   .setZone(…)`) — the local date of a moment, which with a day start is
 *   not its OpenTask day.
 * - HAND-ROLLED DAY-START MINUTES: `% 1440`, or `parseHHMM(` of a rollover /
 *   day start, outside the helpers (`minutesIntoDay`).
 *
 * THE ALLOWLIST below is every such line left, each with its reason. Most
 * are the surfaces PR 2 moves onto the OpenTask day ("PR 2 moves this" —
 * PR 2 empties those); the rest are calendar dates on purpose, the
 * switch-off path, or not a user's day at all. Two are open questions for a
 * ruling (decks, stats/History — see their reasons). The count is exact, and
 * an entry that no longer matches fails too, so the list stays true.
 */
import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const PR2 = 'PR 2 moves this'
const PR2_OVERDUE = `${PR2}: overdue "now" (the badge, the Today pill, the notifier) — a repeat with no target falls back to today's occurrence by the calendar day`
const PR2_SEGMENTS = `${PR2}: the horizon segments, Upcoming heads-up days and "considered today" on the Reminders screen's task side, check_in_day`
const PR2_QUOTA_PAGE = `${PR2}: the Quotas page — "% of day" and "N days left" (periodBounds / periodDaysLeft)`
const PR2_NOW = `${PR2}: "Today" / "Tomorrow" in date labels (the Now view, the Today pill)`
const DECKS =
  'decks are dated by the calendar (on_deck_day, A2/A4: from midnight to the day start the calendar date is the coming day). With a day start after 12:00 the calendar date LAGS the OpenTask day from the start to midnight — not in PR 2’s list; needs a ruling'
const CALENDAR =
  'a calendar date the user picked, typed or stored, read as a date (not "which day is it")'
const SWITCH_OFF = "the switch-off path: the calendar day, which is CALENDAR_DAY_START's day"
const STATS_HISTORY =
  'daily stats and History browse calendar dates — not in PR 2’s list; needs a ruling'
const SHELVED = 'not a user day: shelved AI code (What’s Next / Insights / Quick Take), UTC dates'
const NOT_A_DAY = 'not a user day: a UTC date stamp (an export file name)'

/** `file: trimmed line` → [occurrences, reason]. */
const ALLOWLIST: Record<string, [number, string]> = {
  // ── PR 2 moves these ────────────────────────────────────────────────
  "src/core/recurrence/occurrence.ts: const dayStart = day ? DateTime.fromJSDate(day.start) : localNow.startOf('day')":
    [1, PR2_OVERDUE],
  'src/core/tasks/segment-roster.ts: const calendarDay = (d: Date) => DateTime.fromJSDate(d).setZone(timezone).toISODate()!':
    [1, PR2_SEGMENTS],
  "src/core/tasks/task-segments.ts: const day = DateTime.fromISO(at, { zone: 'utc' }).setZone(timezone).startOf('day')":
    [1, `${PR2_SEGMENTS} ("Today" from a segment: target today or later)`],
  "src/core/tasks/task-segments.ts: const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')":
    [1, `${PR2_SEGMENTS} ("Today" from a segment: target today or later)`],
  "src/lib/task-segments.ts: return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).startOf('day')":
    [1, `${PR2_SEGMENTS} (localDay)`],
  "src/lib/task-segments.ts: const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')":
    [3, `${PR2_SEGMENTS} (targetIsToday, segmentState, upcomingState)`],
  "src/lib/track.ts: const start = local.startOf('day')": [1, PR2_QUOTA_PAGE],
  "src/lib/track.ts: const startOfToday = DateTime.fromJSDate(now).setZone(timezone).startOf('day')":
    [1, PR2_QUOTA_PAGE],
  "src/lib/format-date.ts: const dayA = DateTime.fromJSDate(a, opts).startOf('day')": [1, PR2_NOW],
  "src/lib/format-date.ts: const dayB = DateTime.fromJSDate(b, opts).startOf('day')": [1, PR2_NOW],

  // ── Decks (open question) ───────────────────────────────────────────
  'src/lib/task-segments.ts: return DateTime.fromJSDate(now).setZone(timezone).toFormat(DECK_DAY_FORMAT)':
    [1, `${DECKS} (calendarToday)`],
  "src/core/ai/enrichment.ts: const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')":
    [2, `${DECKS} (settleDeckDay); and dropUnstatedPastDates: ${CALENDAR}`],
  "src/core/ai/enrichment.ts: const settled = settleDeckDay(day.startOf('day'), inputText, today, opts, now)":
    [1, DECKS],
  "src/lib/just-added.ts: const today = DateTime.fromMillis(now).setZone(timezone).startOf('day')":
    [1, `${DECKS} (deckTagLabel)`],
  'src/lib/deck-menu.ts: latestDay: today.minus({ days: 1 }).toFormat(DECK_DAY_FORMAT),': [
    1,
    DECKS,
  ],
  'src/components/OnDeckButton.tsx: const tomorrow = DateTime.fromISO(today).plus({ days: 1 }).toFormat(DECK_DAY_FORMAT)':
    [1, DECKS],

  // ── Calendar dates on purpose ───────────────────────────────────────
  "src/core/ai/enrichment.ts: return local !== null && local.startOf('day') < today": [1, CALENDAR],
  "src/core/tasks/repeat-schedule.ts: const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')":
    [1, `${CALENDAR} (repeat until: not in the past)`],
  "src/core/tasks/skip-until.ts: const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')":
    [1, `${CALENDAR} (skip until: tomorrow or later)`],
  'src/components/quick-panel/EveryTimePanel.tsx: const today = DateTime.fromJSDate(ctx.now).setZone(ctx.timezone).toISODate()!':
    [1, `${CALENDAR} (the repeat-until picker's earliest date)`],
  "src/lib/task-segments.ts: const wait = waitDays(deadlineDay, DateTime.fromJSDate(now).setZone(zone).startOf('day'))":
    [1, `${CALENDAR} (calendar days to a deadline: the automatic target's lead, switch off)`],
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
  "src/lib/task-segments.ts: : DateTime.fromJSDate(instant).setZone(timezone).startOf('day')": [
    1,
    `${SWITCH_OFF} (putBackCountedThrough)`,
  ],
  "src/lib/task-segments.ts: return DateTime.fromISO(deadlineAt, { zone: 'utc' }).setZone(timezone).toFormat(DECK_DAY_FORMAT)":
    [1, `${SWITCH_OFF} (repeatingDeadlineDay)`],

  // ── Stats and History (open question) ───────────────────────────────
  "src/core/stats/index.ts: const dateStr = userNow.toFormat('yyyy-MM-dd')": [1, STATS_HISTORY],
  "src/core/stats/index.ts: const todayStr = userNow.toFormat('yyyy-MM-dd')": [1, STATS_HISTORY],
  "src/core/stats/index.ts: const weekAgoStr = userNow.minus({ days: 7 }).toFormat('yyyy-MM-dd')": [
    1,
    STATS_HISTORY,
  ],
  "src/core/stats/index.ts: const monthAgoStr = userNow.minus({ days: 30 }).toFormat('yyyy-MM-dd')":
    [1, STATS_HISTORY],
  'src/app/history/page.tsx: const date = pickedDate ?? DateTime.now().setZone(timezone).toISODate()!':
    [1, STATS_HISTORY],

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
}

/** The helpers themselves (and `minutesIntoDay`'s home beside the slot pager). */
const HELPERS = new Set(['src/lib/opentask-day.ts'])
const MINUTE_HELPERS = new Set(['src/lib/opentask-day.ts', 'src/lib/time-slot-assign.ts'])

const DAY_OP =
  /\.startOf\(\s*'day'\s*\)|\.endOf\(\s*'day'\s*\)|\.toISODate\(\)|toFormat\(\s*('yyyy-MM-dd'|DECK_DAY_FORMAT|ATTEMPTS_DATE_FORMAT)\s*\)|setHours\(\s*0|toISOString\(\)\s*\.(split\(\s*'T'\s*\)|slice\(\s*0\s*,\s*10\s*\))|toLocaleDateString\(\s*'en-CA'/
const READS_CLOCK =
  /\b(now|localNow|today|userNow)\b|Date\.now\(\)|DateTime\.(now|local)\(\)|new Date\(\)/
const INSTANT_TO_LOCAL = /fromJSDate\(|fromMillis\(|\{\s*zone:\s*'utc'\s*\}\)\.setZone\(/
const MINUTES = /%\s*1440\b|parseHHMM\(\s*(rolloverTime|dayStart|rollover)\b/
const NOW_VAR =
  /(?:const|let)\s+(\w+)\s*=\s*DateTime\.(?:fromJSDate|fromMillis)\(\s*(?:\w+\.)?now\b|(?:const|let)\s+(\w+)\s*=\s*DateTime\.(?:now|local)\(\)/

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return files(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })
}

/** Every flagged line in src/, as `file: trimmed line`, with how often it occurs. */
function flagged(): Map<string, number> {
  const root = process.cwd()
  const found = new Map<string, number>()
  for (const f of files(path.join(root, 'src'))) {
    const rel = path.relative(root, f)
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    const nowVars = lines
      .map((l) => l.match(NOW_VAR))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => new RegExp(`\\b${m[1] ?? m[2]}\\b`))
    for (const raw of lines) {
      const line = raw.trim()
      if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue
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
