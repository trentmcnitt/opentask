import { DateTime } from 'luxon'
import { queueMarked } from '@/lib/queue-tomorrow'
import { showErrorToast, showSuccessToast } from '@/lib/toast'
import { isTracked, quotaPeriodOf, type QuotaFreq } from '@/lib/track'
import type { Task } from '@/types'

/**
 * SHARE A TASK (Trent, 2026-11-18: wanting someone's opinion on a task; "just
 * the ability to quickly attach this to a message"). What is shared is
 * plain text someone with no OpenTask account can read: the title; then, each
 * only when the task has it, its deadline, its target and its notes. No link
 * (nobody else can open the task), no ids, no labels, no project.
 *
 * - A reminder or a quota shares its title and notes only (a reminder's time
 *   of day is not a target), a quota with its count first: "2 a week".
 * - The target is printed only when the user picked it: not an automatic
 *   target and not the queue's "tomorrow" mark, which are the app's own.
 * - Dates are absolute, in the sharer's timezone ("Fri Nov 20, 5:00 PM", the
 *   year added when it is not this year): "tomorrow" means nothing in a
 *   message read a day later.
 */
export type ShareableTask = Pick<
  Task,
  'title' | 'notes' | 'due_at' | 'deadline_at' | 'rrule' | 'progress_target'
> &
  Partial<Pick<Task, 'target_auto' | 'is_reminder' | 'is_tracked' | 'queue_mark'>>

const FREQ_WORD: Record<QuotaFreq, string> = {
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
  YEARLY: 'year',
}

/** "2 a week", "1 every 2 weeks"; null for a quota with no period. */
export function quotaShareWords(task: Pick<Task, 'rrule' | 'progress_target'>): string | null {
  const period = quotaPeriodOf(task.rrule)
  const count = task.progress_target
  if (!period) return null
  const word = FREQ_WORD[period.freq]
  return period.interval > 1 ? `${count} every ${period.interval} ${word}s` : `${count} a ${word}`
}

/** "Fri Nov 20, 5:00 PM" in `timezone`, with the year when it is not `now`'s. */
export function shareMoment(iso: string, timezone: string, now: Date = new Date()): string {
  const at = DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone)
  const thisYear = DateTime.fromJSDate(now).setZone(timezone).year
  return at.toFormat(at.year === thisYear ? 'ccc LLL d, h:mm a' : 'ccc LLL d yyyy, h:mm a')
}

/**
 * THE MACHINE PARTS OF NOTES, left out of a share. Tasks made by other
 * programs carry lines that are for those programs (how to find the source
 * message again, which program owns the task); they mean nothing to the
 * person the task is shared with. Three shapes, each narrow enough that a
 * line a person wrote is not caught:
 *
 * 1. A bracketed command with a reference, on a line of its own or closing
 *    one: `[tool verb <reference>]` or `[tool verb scheme:reference]` — two
 *    or more lowercase words, then one token that is `<…>` or holds a colon.
 *    "[x] buy milk" and "[draft]" are not this.
 * 2. A key line: `some-slug: name=value`, optionally followed by `#tag`
 *    tokens — a hyphenated lowercase slug, a colon, and a `name=value` with
 *    no spaces. "follow-up: call back" is not this.
 * 3. A program's signature sentence: a line opening "Made by the … desk".
 *
 * Blank lines left at the ends, and runs of them inside, are tidied after.
 */
const BRACKET_COMMAND =
  /[ \t]*\[[a-z][a-z0-9_-]*(?: [a-z][a-z0-9_-]*)+ (?:<[^<>\]\n]+>|[^\s\]]*:[^\s\]]+)\][ \t]*$/
const KEY_LINE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+: [^\s=]+=\S+(?: #\S+)*$/
const SIGNATURE_LINE = /^Made by the [a-z][a-z -]* desk\b/

export function stripMachineLines(notes: string): string {
  const kept: string[] = []
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.replace(BRACKET_COMMAND, '')
    const text = line.trim()
    if (text === '' && raw.trim() !== '') continue
    if (KEY_LINE.test(text) || SIGNATURE_LINE.test(text)) continue
    kept.push(line.trimEnd())
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The text a Share hands over (see the header). */
export function taskShareText(
  task: ShareableTask,
  timezone: string,
  now: Date = new Date(),
): string {
  const lines = [task.title.trim()]
  const quota = isTracked({
    progress_target: task.progress_target,
    is_tracked: task.is_tracked ?? false,
  })
  if (quota) {
    const words = quotaShareWords(task)
    if (words) lines.push(words)
  } else if (!task.is_reminder) {
    if (task.deadline_at) lines.push(`Deadline ${shareMoment(task.deadline_at, timezone, now)}`)
    if (task.due_at && !task.target_auto && !queueMarked(task)) {
      lines.push(`Target ${shareMoment(task.due_at, timezone, now)}`)
    }
  }
  const notes = stripMachineLines(task.notes ?? '')
  return notes ? `${lines.join('\n')}\n\n${notes}` : lines.join('\n')
}

/**
 * Hand `text` to whatever shares here, from inside the click that asked (the
 * share sheet and the clipboard both need the user's gesture, so nothing is
 * awaited before them):
 *
 * 1. the system share sheet (`navigator.share`), where it exists — a phone's
 *    browser, Safari, and the native apps' web views, which need no bridge
 *    for it (a WKWebView on iOS and on macOS shows the system sheet;
 *    checked in a bare web view on each, 2026-11-18). A sheet the user closes without sharing is not a failure
 *    and copies nothing;
 * 2. else the clipboard, with a "Copied" toast.
 */
export function shareText(text: string): void {
  if (typeof navigator.share === 'function') {
    navigator.share({ text }).catch((err: unknown) => {
      // Closed without sharing: nothing to say. Anything else: the clipboard.
      if (err instanceof DOMException && err.name === 'AbortError') return
      copyText(text)
    })
    return
  }
  copyText(text)
}

function copyText(text: string): void {
  if (!navigator.clipboard) {
    showErrorToast("Couldn't copy")
    return
  }
  navigator.clipboard.writeText(text).then(
    () => showSuccessToast('Copied'),
    () => showErrorToast("Couldn't copy"),
  )
}

/** Share one task: its text. */
export function shareTask(task: ShareableTask, timezone: string): void {
  shareText(taskShareText(task, timezone))
}
