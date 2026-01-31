'use client'

import { TaskRow } from './TaskRow'
import type { Task } from '@/types'

interface TaskListProps {
  tasks: Task[]
  onDone: (taskId: number) => void
  onSnooze: (task: Task) => void
}

export function TaskList({ tasks, onDone, onSnooze }: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="text-4xl mb-4">&#x2705;</div>
        <h2 className="text-xl font-medium text-zinc-900 dark:text-zinc-100">
          All caught up!
        </h2>
        <p className="text-zinc-500 dark:text-zinc-400 mt-1">
          No tasks due right now.
        </p>
      </div>
    )
  }

  // Group tasks by due date
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)
  const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)

  const groups: { label: string; tasks: Task[] }[] = []

  const overdue: Task[] = []
  const todayTasks: Task[] = []
  const tomorrowTasks: Task[] = []
  const thisWeek: Task[] = []
  const later: Task[] = []
  const noDue: Task[] = []

  for (const task of tasks) {
    if (!task.due_at) {
      noDue.push(task)
      continue
    }

    const due = new Date(task.due_at)

    if (due < now) {
      overdue.push(task)
    } else if (due < tomorrow) {
      todayTasks.push(task)
    } else if (due < new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)) {
      tomorrowTasks.push(task)
    } else if (due < nextWeek) {
      thisWeek.push(task)
    } else {
      later.push(task)
    }
  }

  if (overdue.length > 0) groups.push({ label: 'Overdue', tasks: overdue })
  if (todayTasks.length > 0) groups.push({ label: 'Today', tasks: todayTasks })
  if (tomorrowTasks.length > 0) groups.push({ label: 'Tomorrow', tasks: tomorrowTasks })
  if (thisWeek.length > 0) groups.push({ label: 'This Week', tasks: thisWeek })
  if (later.length > 0) groups.push({ label: 'Later', tasks: later })
  if (noDue.length > 0) groups.push({ label: 'No Due Date', tasks: noDue })

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.label}>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2 px-1">
            {group.label}
            <span className="ml-2 text-zinc-400 dark:text-zinc-500">
              {group.tasks.length}
            </span>
          </h2>
          <div className="space-y-1">
            {group.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onDone={() => onDone(task.id)}
                onSnooze={() => onSnooze(task)}
                isOverdue={group.label === 'Overdue'}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
