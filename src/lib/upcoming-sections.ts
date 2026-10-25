/**
 * UPCOMING'S TWO SECTIONS on the web (2026-10-25, the Upcoming split — plan
 * `plan-upcoming-split-1024.md`, PR B; docs/TASK-MODEL.md § Upcoming).
 *
 * The server sends ONE `upcoming` segment whose rows each carry
 * `upcoming_section` ('tomorrow' | 'later'), Tomorrow's rows first. The page
 * draws them as two sub-lists under one segment header — "Tomorrow" first,
 * then "Later" — each with its own "n of m" and its own considered rows. The
 * segment-level "N of M", "Considered all" and "Defer all" stay the page's
 * (decision 11). BOTH headings are always drawn; an empty one reads
 * "Nothing today ✓" (decision 3).
 *
 * Pure: the split is tested in `tests/behavioral/up-sections-web.test.ts`.
 */
import { UPCOMING_SECTIONS, type UpcomingSection } from '@/lib/task-segments'
import type { SegmentRow } from '@/hooks/useTaskSegments'

/** One section's rows, as the page draws them. */
export interface UpcomingSectionView {
  section: UpcomingSection
  /** Still waiting, in the server's order (its anchor, then id). */
  waiting: SegmentRow[]
  /** Considered, deferred, or left handled today (behind "Show N considered"). */
  handled: SegmentRow[]
  /** "n of m": n handled, m everything the section held today. */
  counts: { handled: number; total: number }
  /** No rows at all today: "Nothing today ✓". */
  empty: boolean
}

/** A row's section; a row with none (never sent so by the server) reads as Later. */
export function sectionOf(row: SegmentRow): UpcomingSection {
  return row.section ?? 'later'
}

/** The segment's rows split into Tomorrow then Later (`UPCOMING_SECTIONS`). */
export function upcomingSections(rows: readonly SegmentRow[]): UpcomingSectionView[] {
  return UPCOMING_SECTIONS.map((section) => {
    const mine = rows.filter((r) => sectionOf(r) === section)
    const waiting = mine.filter((r) => r.state === 'waiting')
    const handled = mine.filter((r) => r.state !== 'waiting')
    return {
      section,
      waiting,
      handled,
      counts: { handled: handled.length, total: mine.length },
      empty: mine.length === 0,
    }
  })
}

/**
 * THE ROW CAP ACROSS BOTH SECTIONS (the dashboard pager's WIDE_CAP /
 * NARROW_CAP): one budget for the page, spent on Tomorrow first, then Later —
 * so "Show more" counts the page, not a section. Returns, for each section,
 * how many of its waiting rows are visible (`visible`) and the page-wide index
 * its first row has (`offset`), for the narrow cap's `hiddenWhenNarrow`.
 */
export function capAcrossSections(
  sections: readonly UpcomingSectionView[],
  cap: number | null,
): { visible: number; offset: number }[] {
  let used = 0
  return sections.map((s) => {
    const offset = used
    const visible =
      cap === null ? s.waiting.length : Math.max(0, Math.min(s.waiting.length, cap - used))
    used += s.waiting.length
    return { visible, offset }
  })
}
