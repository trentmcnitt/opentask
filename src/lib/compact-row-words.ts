/**
 * The COMPACT ROW's deadline (On deck in Today, Trent 2026-10-28): "⚑ Fri"
 * — the DAY only, never a time, and only for a deadline within 7 OpenTask
 * days either side (a passed one says so in red). Farther off, nothing: the
 * full row and the editor have the date.
 */
import { capitalized, nightDay, nightDayWords } from '@/lib/night-day'

const WEEK = 7

export interface CompactDeadline {
  /** "Today", "Tonight", "Tomorrow", "Fri", "Thu night", "Yesterday". */
  words: string
  passed: boolean
}

export function compactDeadline(
  deadlineAt: string | null,
  timezone: string,
  dayStart: string,
  now: Date,
): CompactDeadline | null {
  if (!deadlineAt) return null
  const at = new Date(deadlineAt)
  const n = nightDay(at, timezone, dayStart, now)
  if (Math.abs(n.gap) >= WEEK) return null
  const passed = at < now
  return { words: capitalized(nightDayWords(n, passed)), passed }
}
