/**
 * Shared formatting utilities for AI prompts
 *
 * Used by What's Next, Insights, and quality tests to format task data
 * consistently for the AI model.
 */

import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { getAnchorTimes } from '@/core/users/anchor-times'
import { formatMorningTime } from '@/lib/snooze'
import type { TaskSummary } from './types'

/**
 * Format an ISO UTC date as human-readable local time for the AI prompt.
 * Example: "Mon, Feb 9, 4:00 PM"
 */
export function formatLocalDate(isoUtc: string, timezone: string): string {
  const dt = DateTime.fromISO(isoUtc, { zone: 'utc' }).setZone(timezone)
  return dt.toFormat('ccc, LLL d, h:mm a')
}

/** An on-deck day (yyyy-MM-dd, a local date) for the prompt: "Sat, Oct 24". */
export function formatDeckDay(day: string, timezone: string): string {
  const dt = DateTime.fromISO(day, { zone: timezone })
  return dt.isValid ? dt.toFormat('ccc, LLL d') : day
}

/**
 * Pre-compute a human-readable age string from a UTC timestamp.
 * Prevents the AI from miscounting task age (a common hallucination).
 */
export function formatAge(isoUtc: string, now: DateTime): string {
  const dt = DateTime.fromISO(isoUtc, { zone: 'utc' })
  const days = Math.floor(now.diff(dt, 'days').days)
  if (days <= 0) return 'today'
  if (days === 1) return '1 day ago'
  if (days < 7) return `${days} days ago`
  const weeks = Math.floor(days / 7)
  if (days < 30) return `${weeks} week${weeks > 1 ? 's' : ''} ago`
  const months = Math.floor(days / 30)
  return `${months} month${months > 1 ? 's' : ''} ago`
}

/**
 * Format a task as a human-readable line for AI prompts.
 * Used by both What's Next and Insights for consistent task representation.
 *
 * Task model (2026-10-10): `due_at` is the TARGET, so it is printed as
 * `target:`; `deadline:` and `horizon:` appear only when set, so a task with
 * neither reads exactly as before apart from the word. The first-target date
 * (`original_due_at`) stays P3+ only — the grounding rules let the model say a
 * P0-3 target was "pushed back" only where it can see the history, and showing
 * it on every line would invite exactly that narrative about routine sweeps.
 *
 * A task ON DECK (no target; `on_deck_day`) reads `on deck: Sat, Oct 24` in
 * the target's place.
 *
 * The deadline's automatic target (no target the user picked — `target_auto`,
 * carried as `target_implied`) reads `target: <date> (from deadline)` and
 * never gets the first-target note: comparing an old target with an automatic
 * one would describe a move nobody made.
 */
export function formatTaskLine(t: TaskSummary, timezone: string, now: DateTime): string {
  const due = t.due_at
    ? `${formatLocalDate(t.due_at, timezone)}${t.target_implied ? ' (from deadline)' : ''}`
    : 'none'
  // On deck (B11, 2026-10-20): a task with no target the user planned for a
  // day reads "on deck: Sat, Oct 24" — not "target: none", which the models
  // read as never planned (Insights' "no target for 2 months").
  const deck = t.on_deck_day ? formatDeckDay(t.on_deck_day, timezone) : null
  const when =
    deck && !t.due_at ? `on deck: ${deck}` : `target: ${due}${deck ? ` | on deck: ${deck}` : ''}`
  const originalDue =
    !t.target_implied &&
    t.priority >= 3 &&
    t.due_at &&
    t.original_due_at &&
    t.original_due_at !== t.due_at
      ? ` (first target: ${formatLocalDate(t.original_due_at, timezone)})`
      : ''
  const deadline = t.deadline_at ? ` | deadline: ${formatLocalDate(t.deadline_at, timezone)}` : ''
  const horizon = t.horizon ? ` | horizon: ${t.horizon}` : ''
  const created = formatLocalDate(t.created_at, timezone)
  const createdAge = formatAge(t.created_at, now)
  const rrule = t.rrule ? `rrule: ${t.rrule}` : 'one-off'
  const recMode = t.recurrence_mode !== 'from_due' ? ` | recurrence_mode: ${t.recurrence_mode}` : ''
  const notes = t.notes ? ` | notes: ${t.notes}` : ''
  return (
    `- [${t.id}] "${t.title}" | priority: ${t.priority} | ${when}${originalDue}${deadline}${horizon} | ` +
    `created: ${created} (${createdAge}) | labels: ${t.labels.join(', ') || 'none'} | ` +
    `project: ${t.project_name || 'Inbox'} | ${rrule}${recMode}${notes}`
  )
}

/**
 * Build a schedule block for AI prompts from user preferences.
 * Returns an empty string if no schedule data is found.
 */
export function getScheduleBlock(userId: number): string {
  if (!getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return ''
  // Resolved: a Wake or Sleep linked to a period reads its start (2026-10-21).
  const { wake, sleep } = getAnchorTimes(userId)
  return `\nUser's schedule: wakes at ${formatMorningTime(wake.time)}, sleeps at ${formatMorningTime(sleep.time)}\n`
}
