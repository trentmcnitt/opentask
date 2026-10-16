/**
 * The quota count as SEGMENTS (2026-10-13) — the pure half of
 * `src/components/QuotaSegments.tsx`: the words, the fills and the fit rule,
 * kept free of React and the DOM so they can be unit-tested.
 *
 * A quota's count used to read "· 3/7 this week". It is now N small skewed
 * segments, one per unit of the target, filled indigo per completion logged
 * and all green once the quota is met, followed by a short period word:
 * "▰▰▱ week". Plain text ("3/7 week") is the deterministic fallback — see
 * `chooseQuotaCountForm`.
 */
import { QUOTA_PERIODS } from '@/lib/track'

/** More segments than this and the count is text: seven boxes stop being countable at a glance. */
export const MAX_SEGMENTS = 6

export type QuotaCountForm = 'segments' | 'text'

/** One segment's look: not yet logged, logged while the quota is still open, or the quota is met. */
export type SegmentFill = 'empty' | 'filled' | 'met'

/**
 * The word after the segments — "today", "week", "month", "year" (never "this
 * week": the segments already say "so far"). Null for a period-less quota.
 * Read from the FREQ — unless the quota is an INTERVAL quota (2026-10-16) and
 * the server served its end as `label` ("by Oct 24"), which is the word then:
 * "week" would be wrong for a fortnight.
 */
export function quotaSegmentWord(
  freq: string | null | undefined,
  label: string | null = null,
): string | null {
  return label ?? QUOTA_PERIODS.find((p) => p.freq === freq)?.word ?? null
}

/**
 * The group's accessible name, in natural words: "1 of 2 today", "1 of 2 this
 * week", "1 of 2 this month" — the period's full label, since "1 of 2 week" is
 * not something a person says. An interval quota's served label reads as is
 * ("1 of 2 by Oct 24"). A period-less quota is "1 of 2".
 */
export function quotaCountAriaLabel(
  current: number,
  target: number,
  freq: string | null | undefined,
  periodLabel: string | null = null,
): string {
  const label = periodLabel ?? QUOTA_PERIODS.find((p) => p.freq === freq)?.label
  return `${current} of ${target}${label ? ` ${label}` : ''}`
}

/** The text form: "3/7 today", or "3/7" with no word. */
export function quotaCountText(current: number, target: number, word: string | null): string {
  return `${current}/${target}${word ? ` ${word}` : ''}`
}

/**
 * One fill per unit of the target. A met quota is all green — every segment,
 * even when it was met by overflow — so "met" is a colour flip, not a few
 * pixels of length (Trent's rule: completion is a step change). A 1× quota is
 * one segment.
 */
export function segmentFills(current: number, target: number): SegmentFill[] {
  const n = Math.max(1, target)
  if (current >= n) return Array.from({ length: n }, () => 'met' as const)
  return Array.from({ length: n }, (_, i) => (i < current ? 'filled' : 'empty'))
}

/**
 * THE FIT RULE — the one place the count decides between segments and text.
 *
 * 1. More than `MAX_SEGMENTS` → text, always, wherever it sits.
 * 2. No width to fit into (`available` undefined: a host that lays the count
 *    out in its own column, or before the first measurement) → segments.
 * 3. The segments (plus their word, and the space before them) fit in what is
 *    left of the line where they start → segments.
 * 4. They don't, but the text does → text.
 * 5. Neither fits → segments, and the host's `white-space: nowrap` wraps them
 *    to the next line as one piece.
 *
 * Widths are layout pixels, compared exactly — no slack. The caller measures
 * `available` from a point that does not move with the choice (the end of the
 * content BEFORE the count), so a choice never invalidates itself.
 */
export function chooseQuotaCountForm({
  target,
  available,
  segmentsWidth,
  textWidth,
}: {
  target: number
  available?: number
  segmentsWidth?: number
  textWidth?: number
}): QuotaCountForm {
  if (target > MAX_SEGMENTS) return 'text'
  if (available === undefined || segmentsWidth === undefined || textWidth === undefined) {
    return 'segments'
  }
  if (segmentsWidth <= available) return 'segments'
  if (textWidth <= available) return 'text'
  return 'segments'
}
