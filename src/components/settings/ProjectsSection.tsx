'use client'

import { useState, useEffect } from 'react'
import { Trash2 } from 'lucide-react'
import { useProjects } from '@/components/ProjectsProvider'
import { SortableProjectList, DragHandle } from '@/components/SortableProjectList'
import type { SortableProject, DragHandleProps } from '@/components/SortableProjectList'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { LABEL_COLORS, LABEL_COLOR_NAMES } from '@/lib/label-colors'
import { showToast } from '@/lib/toast'
import type { LabelColor, Project } from '@/types'
import { ColorDot } from './ColorDot'
import { SettingsSection } from './SettingsSection'

/**
 * Settings → Projects: drag to reorder, add a project with a color, and
 * delete one (confirmed; its tasks move to Inbox). Shared projects and Inbox
 * can't be deleted, and shared ones can't be dragged.
 */
export function ProjectsSection() {
  const { projects, refreshProjects } = useProjects()
  const [projectOrder, setProjectOrder] = useState<Project[]>([])
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectColor, setNewProjectColor] = useState<LabelColor>('blue')
  const [creatingProject, setCreatingProject] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null)

  // Sync project order from provider
  useEffect(() => {
    setProjectOrder(projects)
  }, [projects])

  const handleProjectReorder = async (projectIds: number[]) => {
    const prev = projectOrder
    setProjectOrder(projectIds.map((id) => prev.find((p) => p.id === id)!).filter(Boolean))
    try {
      const res = await fetch('/api/projects/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_ids: projectIds }),
      })
      if (!res.ok) throw new Error('Failed to save')
      await refreshProjects()
      showToast({ message: 'Project order saved', type: 'success' })
    } catch {
      setProjectOrder(prev)
      showToast({ message: 'Failed to reorder projects', type: 'error' })
    }
  }

  const handleCreateProject = async () => {
    const trimmed = newProjectName.trim()
    if (!trimmed || creatingProject) return
    setCreatingProject(true)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, color: newProjectColor }),
      })
      if (!res.ok) throw new Error('Failed to create')
      await refreshProjects()
      setNewProjectName('')
      showToast({ message: 'Project created', type: 'success' })
    } catch {
      showToast({ message: 'Failed to create project', type: 'error' })
    } finally {
      setCreatingProject(false)
    }
  }

  const handleDeleteProject = async () => {
    if (!projectToDelete) return
    try {
      const res = await fetch(`/api/projects/${projectToDelete.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
      await refreshProjects()
      showToast({ message: 'Project deleted. Tasks moved to Inbox.', type: 'success' })
    } catch {
      showToast({ message: 'Failed to delete project', type: 'error' })
    } finally {
      setProjectToDelete(null)
    }
  }

  return (
    <>
      <SettingsSection
        title="Projects"
        description="Drag to reorder projects. This order is used in the sidebar and project picker."
      >
        {projectOrder.length > 0 && (
          <SortableProjectList
            projects={projectOrder}
            onReorder={handleProjectReorder}
            renderItem={(project, dragHandleProps) => (
              <ProjectRow
                project={project}
                full={projectOrder.find((p) => p.id === project.id)}
                dragHandleProps={dragHandleProps}
                onDelete={setProjectToDelete}
              />
            )}
          />
        )}

        {/* Add new project row */}
        <div className="flex items-center gap-2 pt-2">
          <Input
            type="text"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateProject()
            }}
            placeholder="New project"
            maxLength={200}
            disabled={creatingProject}
            className="h-8 w-32 text-sm"
          />
          <div className="flex items-center gap-1">
            {LABEL_COLOR_NAMES.map((c) => (
              <ColorDot
                key={c}
                color={c}
                selected={newProjectColor === c}
                onClick={() => setNewProjectColor(c)}
                ariaLabel={`${LABEL_COLORS[c].display} color`}
              />
            ))}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleCreateProject}
            disabled={!newProjectName.trim() || creatingProject}
            className="h-8"
          >
            Add
          </Button>
        </div>
      </SettingsSection>

      <DeleteProjectDialog
        project={projectToDelete}
        onCancel={() => setProjectToDelete(null)}
        onConfirm={handleDeleteProject}
      />
    </>
  )
}

/**
 * One project in the sortable list. `full` is the Project behind the list's
 * slimmer SortableProject (color, shared). Shared projects get a spacer instead
 * of a drag handle; shared projects and Inbox get no delete button.
 */
function ProjectRow({
  project,
  full,
  dragHandleProps,
  onDelete,
}: {
  project: SortableProject
  full: Project | undefined
  dragHandleProps: DragHandleProps
  onDelete: (project: Project) => void
}) {
  const isShared = full?.shared ?? false
  const canDelete = !isShared && full?.name !== 'Inbox'
  return (
    <div className="flex items-center gap-2 rounded-md border border-transparent px-1 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900">
      {isShared ? (
        <div className="w-4" />
      ) : (
        <DragHandle attributes={dragHandleProps.attributes} listeners={dragHandleProps.listeners} />
      )}
      {full?.color && (
        <span className={`size-2.5 flex-shrink-0 rounded-full ${LABEL_COLORS[full.color].dot}`} />
      )}
      <span className="flex-1 truncate text-sm">{project.name}</span>
      {isShared && <span className="text-xs text-zinc-400">Shared</span>}
      <Badge variant="secondary" className="text-xs tabular-nums">
        {project.active_count ?? 0}
      </Badge>
      {canDelete && full && (
        <button
          onClick={() => onDelete(full)}
          className="text-zinc-300 transition-colors hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400"
          aria-label={`Delete ${full.name}`}
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** Delete project confirmation; open while `project` is set. */
function DeleteProjectDialog({
  project,
  onCancel,
  onConfirm,
}: {
  project: Project | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog
      open={!!project}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {project?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {(project?.active_count ?? 0) > 0
              ? `${project?.active_count} active task${project?.active_count === 1 ? '' : 's'} will be moved to Inbox.`
              : 'This project has no active tasks.'}{' '}
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
