import { startsNote } from '@/lib/start-date-words'
import type { Task } from '@/types'

/**
 * "Starts Jan 1" beside a row's deadline chip (2026-11-12): a deadline task
 * still before its picked start date is on no queue page yet, so the lists
 * that show every task (All, search, Scan) say when it starts. Plain grey
 * text, never truncated; nothing for any other task (`startsNote`).
 */
export function StartsNote({ task, timezone }: { task: Task; timezone: string }) {
  const words = startsNote(task, timezone)
  if (!words) return null
  return (
    <span data-starts-note className="text-muted-foreground text-xs whitespace-nowrap">
      {words}
    </span>
  )
}
