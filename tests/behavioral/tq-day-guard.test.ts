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
 * TQ-G03 covers the CLIENT (and every default): the only places that choose
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
  "src/core/tasks/repeat-schedule.ts: const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')":
    [1, `${CALENDAR} (repeat until: not in the past)`],
  "src/core/tasks/skip-until.ts: const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')":
    [1, `${CALENDAR} (skip until: tomorrow or later)`],
  'src/components/quick-panel/EveryTimePanel.tsx: const today = DateTime.fromJSDate(ctx.now).setZone(ctx.timezone).toISODate()!':
    [1, `${CALENDAR} (the repeat-until picker's earliest date)`],
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
  'src/components/PreferencesProvider.tsx':
    '`useDayStart`: the browser’s one rule, the same as `dayBoundaryForUser`',
  'src/lib/week-start.ts':
    'the switch-off path of the quota period maths, kept exactly as it was (`unitStartAt`, `quotaPeriodEnd`)',
  'src/lib/task-segments.ts':
    'a null rollover time (the switch off) read as calendar days: attempts, the put-back, the deadlines page’s day',
  'src/core/tasks/read.ts':
    'the served quota period of a row whose owner rollover time is null (the switch off)',
}
/** The helpers themselves (and `minutesIntoDay`'s home beside the slot pager). */
const HELPERS = new Set(['src/lib/opentask-day.ts'])
const MINUTE_HELPERS = new Set(['src/lib/opentask-day.ts', 'src/lib/time-slot-assign.ts'])

const DAY_OP =
  /\.startOf\(\s*'day'\s*\)|\.endOf\(\s*'day'\s*\)|\.toISODate\(\)|toFormat\(\s*('yyyy-MM-dd'|DECK_DAY_FORMAT|ATTEMPTS_DATE_FORMAT)\s*\)|setHours\(\s*0|toISOString\(\)\s*\.(split\(\s*'T'\s*\)|slice\(\s*0\s*,\s*10\s*\))|toLocaleDateString\(\s*'en-CA'|hasSame\([^)]*'day'\s*\)/
const READS_CLOCK =
  /\b(now|localNow|today|userNow|nowLocal|nowDt|nowMinute)\b|Date\.now\(\)|DateTime\.(now|local)\(\)|new Date\(\)/
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

  test('TQ-G03c: the browser reads its day start from useDayStart — no client file asks the server helpers or picks midnight', () => {
    const client = srcFiles.filter(
      (f) =>
        (f.startsWith('src/components/') ||
          f.startsWith('src/hooks/') ||
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
