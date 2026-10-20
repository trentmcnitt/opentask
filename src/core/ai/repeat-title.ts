/**
 * Repeat words left in an enriched title (designer, 2026-10-16): Haiku
 * returned "Water the ferns every other day" and "Go to the gym twice a week"
 * with the repeat already in the rule. The prompt says to remove it; this is
 * the deterministic backstop.
 *
 * NARROW BY DESIGN. A phrase is stripped only when
 * - it is the title's TRAILING phrase, or a LEADING one that reads as a time
 *   clause ("Every Monday, …" — never the adjective of a name like "Weekly
 *   standup"); never cut from the middle, where removing it could break the
 *   sentence; and
 * - it says exactly what the parsed rule says, per the small table below:
 *   "every other day" goes only with FREQ=DAILY;INTERVAL=2, "twice a week"
 *   only with a weekly rule on exactly two days, "every Monday" only with
 *   WEEKLY;BYDAY=MO. Anything else — a phrase that disagrees with the rule,
 *   a phrase the table doesn't know — leaves the title alone: the words may
 *   be the user's, and a rule that disagrees is a model error to see, not
 *   to hide.
 * The rest of the title must keep at least one word, and a first letter that
 * was capital stays capital.
 */
import { bydayDows, parseRRule, type RRuleComponents } from '@/core/recurrence'

const WEEKDAYS: Record<string, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
}
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 }
const toNumber = (s: string) => NUMBER_WORDS[s.toLowerCase()] ?? Number(s)

/** The rule's days, sorted; [] when it names none. */
const daysOf = (rule: RRuleComponents) => bydayDows(rule).sort((a, b) => a - b)
const interval = (rule: RRuleComponents) => rule.interval ?? 1
const sameDays = (a: number[], b: number[]) =>
  a.length === b.length && a.every((d, i) => d === b[i])

/**
 * One row: a phrase (a regex body, matched whole and case-insensitively) and
 * whether the parsed rule says the same. `m` is the phrase's match, for rows
 * with a number or weekdays in them.
 */
interface Row {
  phrase: string
  fits: (rule: RRuleComponents, m: RegExpMatchArray) => boolean
}

const DAY = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?'
const DAY_PLURAL = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s'
const COUNT = '(\\d+|two|three|four|five|six)'

const TABLE: Row[] = [
  {
    phrase: '(every day|each day|daily|every single day|every morning|every evening|every night)',
    fits: (r) => r.freq === 'DAILY' && interval(r) === 1,
  },
  { phrase: 'every other day', fits: (r) => r.freq === 'DAILY' && interval(r) === 2 },
  {
    phrase: `every ${COUNT} days`,
    fits: (r, m) => r.freq === 'DAILY' && interval(r) === toNumber(m[1]),
  },
  {
    phrase: '(every week|weekly|once a week)',
    fits: (r) => r.freq === 'WEEKLY' && interval(r) === 1 && daysOf(r).length <= 1,
  },
  {
    phrase: '(every other week|biweekly|every two weeks|every 2 weeks)',
    fits: (r) => r.freq === 'WEEKLY' && interval(r) === 2,
  },
  {
    phrase: 'twice a week',
    fits: (r) => r.freq === 'WEEKLY' && interval(r) === 1 && daysOf(r).length === 2,
  },
  {
    phrase: '(three times|3 times) a week',
    fits: (r) => r.freq === 'WEEKLY' && interval(r) === 1 && daysOf(r).length === 3,
  },
  {
    phrase: '(every weekday|on weekdays|every weekday morning)',
    fits: (r) => r.freq === 'WEEKLY' && interval(r) === 1 && sameDays(daysOf(r), [0, 1, 2, 3, 4]),
  },
  {
    // "every Monday", "every Tuesday and Thursday", "on Mondays" — a bare
    // "on Monday" names one day, not a repeat, so it is not in the table.
    phrase: `(?:every ${DAY}|on ${DAY_PLURAL})(?: and ${DAY})?`,
    fits: (r, m) => {
      const named = [m[1] ?? m[2], m[3]]
        .filter(Boolean)
        .map((d) => WEEKDAYS[d.toLowerCase()])
        .sort((a, b) => a - b)
      return r.freq === 'WEEKLY' && interval(r) === 1 && sameDays(daysOf(r), named)
    },
  },
  {
    phrase: '(every month|monthly|once a month)',
    fits: (r) => r.freq === 'MONTHLY' && interval(r) === 1,
  },
  { phrase: 'every other month', fits: (r) => r.freq === 'MONTHLY' && interval(r) === 2 },
  {
    phrase: '(every 3 months|every three months|quarterly|every quarter)',
    fits: (r) => r.freq === 'MONTHLY' && interval(r) === 3,
  },
  {
    phrase: '(every year|yearly|annually|once a year)',
    fits: (r) => r.freq === 'YEARLY' && interval(r) === 1,
  },
]

/** Uppercase the first letter when the original title started with one. */
function keepCase(original: string, rest: string): string {
  const first = original.charAt(0)
  return first !== first.toLowerCase() ? rest.charAt(0).toUpperCase() + rest.slice(1) : rest
}

/**
 * The title without a leading or trailing repeat phrase that matches `rrule`,
 * or the title unchanged. Exported for enrichment and tests.
 */
export function stripRepeatPhrase(title: string, rrule: string | null): string {
  const t = title?.trim()
  if (!rrule || !t) return title
  const rule = parseRRule(rrule)
  for (const row of TABLE) {
    const whole = new RegExp(`^${row.phrase}$`, 'i')
    const trailing = t.match(
      new RegExp(`^(?<rest>.*?[^\\s,])[\\s,]+(?<phrase>${row.phrase})[.!]?$`, 'i'),
    )
    // A LEADING phrase goes only when it reads as a time clause — it starts
    // with "every"/"each"/"on", or a comma ends it. "Weekly standup", "Daily
    // review", "Monthly report" are names: the adjective stays.
    const leadingMatch = t.match(
      new RegExp(`^(?<phrase>${row.phrase})(?<sep>[\\s,:-]+)(?<rest>\\S.*)$`, 'i'),
    )
    const leading =
      leadingMatch?.groups &&
      (/^(every|each|on)\b/i.test(leadingMatch.groups.phrase) ||
        leadingMatch.groups.sep.includes(','))
        ? leadingMatch
        : null
    for (const m of [trailing, leading]) {
      const phrase = m?.groups?.phrase.match(whole)
      if (m?.groups && phrase && row.fits(rule, phrase)) return finish(t, m.groups.rest)
    }
  }
  return title
}

/** The rest of the title, trimmed; the original when nothing would be left. */
function finish(original: string, rest: string): string {
  const cleaned = rest.replace(/[\s,;:-]+$/, '').trim()
  if (!/[a-z0-9]/i.test(cleaned)) return original
  return keepCase(original, cleaned)
}
