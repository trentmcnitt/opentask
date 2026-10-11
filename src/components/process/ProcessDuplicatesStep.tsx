'use client'

import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Project } from '@/types'
import type { ProcessTask } from '@/lib/process-client'

export interface ShownDuplicateGroup {
  key: string
  reason: string
  tasks: ProcessTask[]
}

/**
 * Process step 2 — possible duplicates (AI-found; the step is absent when AI
 * is off or finds none). Each group lists its tasks; Trash moves one to the
 * Trash (soft delete, Undo on the toast — Trent's "undo beats confirmation"),
 * and "Not duplicates" puts the group away. A group with one task left is
 * done.
 */
export function ProcessDuplicatesStep({
  groups,
  projects,
  onTrash,
  onDismiss,
}: {
  groups: ShownDuplicateGroup[]
  projects: Project[]
  onTrash: (task: ProcessTask) => void
  onDismiss: (group: ShownDuplicateGroup) => void
}) {
  if (groups.length === 0) {
    return <p className="text-muted-foreground py-6 text-center text-sm">No duplicates left.</p>
  }
  const projectName = (id: number) => projects.find((p) => p.id === id)?.name ?? ''

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <div key={group.key} className="rounded-lg border p-3" data-process-duplicate-group>
          {group.reason && <p className="text-muted-foreground mb-2 text-xs">{group.reason}</p>}
          <ul className="flex flex-col gap-1">
            {group.tasks.map((task) => (
              <li key={task.id} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm break-words">{task.title}</p>
                  <p className="text-muted-foreground text-xs">{projectName(task.project_id)}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Trash “${task.title}”`}
                  onClick={() => onTrash(task)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => onDismiss(group)}>
              Not duplicates
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
