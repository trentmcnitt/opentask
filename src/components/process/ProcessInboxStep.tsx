'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getPriorityOption } from '@/lib/priority'
import type { Project } from '@/types'
import type { ProcessTask, Recommendation } from '@/lib/process-client'

/**
 * Process step 1 — sort the Inbox, one task at a time (spec §5; Trent, 10-10:
 * "it shows me the task and I pick the project — always the same projects to
 * choose from, with one picked as the recommendation, so I can sort quickly").
 *
 * - The projects are ALWAYS in the same order — Settings order, as
 *   `useProjects()` serves them — so a hand learns where each one is. The AI's
 *   pick is highlighted with a held background box, never moved to the front
 *   (09-28 ruling: the AI recommends, Trent picks).
 * - One tap moves the task and shows the next. Skip leaves it in the Inbox for
 *   this round. The Inbox itself is not offered: picking it is Skip.
 * - Keys on a desktop: 1–9 pick the first nine projects, S skips.
 * - With AI off, or no recommendation, the buttons are simply all alike.
 */
export function ProcessInboxStep({
  task,
  remaining,
  projects,
  recommendation,
  onMove,
  onSkip,
}: {
  /** The task on screen, or null when the Inbox is sorted. */
  task: ProcessTask | null
  /** Tasks left including this one. */
  remaining: number
  /** Every project but the Inbox, in Settings order. */
  projects: Project[]
  recommendation: Recommendation | undefined
  onMove: (task: ProcessTask, project: Project) => void
  onSkip: (task: ProcessTask) => void
}) {
  useEffect(() => {
    if (!task) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        onSkip(task)
        return
      }
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, projects.length)) {
        e.preventDefault()
        onMove(task, projects[n - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [task, projects, onMove, onSkip])

  if (!task) {
    return <p className="text-muted-foreground py-6 text-center text-sm">Nothing left to sort.</p>
  }

  const priority = getPriorityOption(task.priority)
  const suggested = projects.find((p) => p.id === recommendation?.project_id)

  return (
    <div className="flex flex-col gap-4" data-process-inbox>
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs">{remaining} left in the Inbox</p>
        <p className="text-base font-medium break-words" data-process-inbox-title>
          {task.title}
        </p>
        {task.notes && (
          <p className="text-muted-foreground line-clamp-3 text-sm break-words whitespace-pre-line">
            {task.notes}
          </p>
        )}
        {task.priority > 0 && <p className={cn('text-xs', priority.color)}>{priority.label}</p>}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Move to project">
        {projects.map((project, i) => {
          const isSuggested = project.id === suggested?.id
          return (
            <Button
              key={project.id}
              type="button"
              variant="outline"
              size="sm"
              data-process-project={project.name}
              data-suggested={isSuggested || undefined}
              aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
              onClick={() => onMove(task, project)}
              className={cn(
                'max-w-full min-w-0',
                isSuggested && 'border-primary bg-primary/10 text-primary dark:bg-primary/15',
              )}
            >
              <span className="truncate">{project.name}</span>
            </Button>
          )
        })}
      </div>

      {suggested && recommendation?.reason && (
        <p className="text-muted-foreground text-xs" data-process-reason>
          Suggested: <span className="text-foreground">{suggested.name}</span> —{' '}
          {recommendation.reason}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onSkip(task)}
          aria-keyshortcuts="S"
        >
          Skip
        </Button>
      </div>
    </div>
  )
}
