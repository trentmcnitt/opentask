/**
 * Review session management
 *
 * Creates review sessions that map sequential numbers to task IDs,
 * allowing the CLI to reference tasks by number during batch review.
 */

import { v4 as uuid } from 'uuid'
import { getTasks } from '@/core/tasks'
import type { Task } from '@/types'

interface ReviewSession {
  id: string
  userId: number
  mapping: Map<number, number> // seq number -> task ID
  tasks: Task[]
  createdAt: Date
}

// In-memory session store (sessions are short-lived)
const sessions = new Map<string, ReviewSession>()

// Clean up old sessions (older than 1 hour)
function cleanup() {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const [id, session] of sessions) {
    if (session.createdAt.getTime() < cutoff) {
      sessions.delete(id)
    }
  }
}

/**
 * Create a new review session with grouped, numbered tasks
 */
export function createReviewSession(userId: number): { sessionId: string; groups: ReviewGroup[] } {
  cleanup()

  const tasks = getTasks({
    userId,
    overdue: true,
    limit: 500,
  })

  // Also get tasks due today
  const allTasks = getTasks({
    userId,
    limit: 500,
  })

  // Combine: overdue first, then tasks due within next 24h
  const now = new Date()
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  const reviewTasks = allTasks.filter((t) => {
    if (!t.due_at) return false
    const due = new Date(t.due_at)
    return due < tomorrow
  })

  // Sort: overdue first, then by due_at
  reviewTasks.sort((a, b) => {
    const aDue = a.due_at ? new Date(a.due_at).getTime() : Infinity
    const bDue = b.due_at ? new Date(b.due_at).getTime() : Infinity
    return aDue - bDue
  })

  const sessionId = uuid()
  const mapping = new Map<number, number>()

  // Group by time category
  const overdueGroup: ReviewTaskItem[] = []
  const todayGroup: ReviewTaskItem[] = []

  let seq = 1
  for (const task of reviewTasks) {
    mapping.set(seq, task.id)
    const item: ReviewTaskItem = { seq, task }

    if (task.due_at && new Date(task.due_at) < now) {
      overdueGroup.push(item)
    } else {
      todayGroup.push(item)
    }
    seq++
  }

  sessions.set(sessionId, {
    id: sessionId,
    userId,
    mapping,
    tasks: reviewTasks,
    createdAt: new Date(),
  })

  const groups: ReviewGroup[] = []
  if (overdueGroup.length > 0) groups.push({ label: 'Overdue', items: overdueGroup })
  if (todayGroup.length > 0) groups.push({ label: 'Today', items: todayGroup })

  return { sessionId, groups }
}

/**
 * Get a session and validate it belongs to the user
 */
export function getReviewSession(sessionId: string, userId: number): ReviewSession | null {
  const session = sessions.get(sessionId)
  if (!session || session.userId !== userId) return null
  return session
}

/**
 * Resolve seq numbers (including ranges like "1-5") to task IDs
 */
export function resolveSeqNumbers(session: ReviewSession, specs: string[]): number[] {
  const taskIds: number[] = []

  for (const spec of specs) {
    if (spec.includes('-')) {
      const [startStr, endStr] = spec.split('-')
      const start = parseInt(startStr)
      const end = parseInt(endStr)
      if (isNaN(start) || isNaN(end) || start > end) {
        throw new Error(`Invalid range: ${spec}`)
      }
      for (let i = start; i <= end; i++) {
        const taskId = session.mapping.get(i)
        if (taskId) taskIds.push(taskId)
        else throw new Error(`No task with number ${i}`)
      }
    } else {
      const num = parseInt(spec)
      if (isNaN(num)) throw new Error(`Invalid number: ${spec}`)
      const taskId = session.mapping.get(num)
      if (taskId) taskIds.push(taskId)
      else throw new Error(`No task with number ${num}`)
    }
  }

  return taskIds
}

/**
 * Delete a session after use
 */
export function deleteReviewSession(sessionId: string) {
  sessions.delete(sessionId)
}

export interface ReviewTaskItem {
  seq: number
  task: Task
}

export interface ReviewGroup {
  label: string
  items: ReviewTaskItem[]
}
