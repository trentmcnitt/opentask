/**
 * Shared formatting utilities for AI prompts
 *
 * Used by What's Next, Insights, and quality tests to format task data
 * consistently for the AI model.
 */

import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
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
 * A target the deadline implies (no target of the user's own, or theirs falls
 * after the deadline — `target_implied`) reads `target: <date> (from deadline)`
 * and never gets the first-target note: comparing the user's old target with
 * an implied one would describe a move nobody made.
 */
export function formatTaskLine(t: TaskSummary, timezone: string, now: DateTime): string {
  const due = t.due_at
    ? `${formatLocalDate(t.due_at, timezone)}${t.target_implied ? ' (from deadline)' : ''}`
    : 'none'
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
    `- [${t.id}] "${t.title}" | priority: ${t.priority} | target: ${due}${originalDue}${deadline}${horizon} | ` +
    `created: ${created} (${createdAge}) | labels: ${t.labels.join(', ') || 'none'} | ` +
    `project: ${t.project_name || 'Inbox'} | ${rrule}${recMode}${notes}`
  )
}

/**
 * Build a schedule block for AI prompts from user preferences.
 * Returns an empty string if no schedule data is found.
 */
export function getScheduleBlock(userId: number): string {
  const db = getDb()
  const userSchedule = db
    .prepare('SELECT wake_time, sleep_time FROM users WHERE id = ?')
    .get(userId) as { wake_time: string; sleep_time: string } | undefined
  return userSchedule
    ? `\nUser's schedule: wakes at ${formatMorningTime(userSchedule.wake_time)}, sleeps at ${formatMorningTime(userSchedule.sleep_time)}\n`
    : ''
}
