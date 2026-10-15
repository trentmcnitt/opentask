'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { Trash2 } from 'lucide-react'
import { useProjects } from '@/components/ProjectsProvider'
import { SortableProjectList, DragHandle } from '@/components/SortableProjectList'
import type { SortableProject, DragHandleProps } from '@/components/SortableProjectList'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
import { savePreferenceField } from '@/lib/save-preference'
import { useProjectPreviewCount } from '@/components/PreferencesProvider'
import { PROJECT_DESCRIPTION_MAX } from '@/lib/project-description'
import type { LabelColor, Project } from '@/types'
import { ColorDot } from './ColorDot'
import { SettingsSection } from './SettingsSection'

/**
 * Settings → Projects: drag to reorder, add a project with a color, describe
 * what belongs in one, and delete one (confirmed; its tasks move to Inbox). Shared projects and Inbox
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
        description="Drag to reorder projects. This order is used in the sidebar and project picker. A description says what belongs in a project, for the AI and for apps that file tasks over the API."
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
                onSaved={refreshProjects}
              />
            )}
          />
        )}

        {/* Add new project row. Wraps rather than squeezing the name field
            down to "New p" when the colours don't fit beside it (390px). */}
        <div className="flex flex-wrap items-center gap-2 pt-2">
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
            className="h-8 w-32 shrink-0 text-sm"
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

        <ProjectPreviewCountRow />
      </SettingsSection>

      <DeleteProjectDialog
        project={projectToDelete}
        onCancel={() => setProjectToDelete(null)}
        onConfirm={handleDeleteProject}
      />
    </>
  )
}

/** The choices the per-project cap offers (the API takes any 1-50). */
const PREVIEW_COUNT_PRESETS = [3, 4, 5, 6, 8, 10, 15, 20, 30, 50]

/**
 * How many tasks each project group in the dashboard's Now view shows, with
 * its folds lifted ("Show all"), before its "Show all N" button (`project_preview_count`, default 6). A preset select
 * like the other Settings choices; a value set through the API that isn't a
 * preset is listed too, so the select never shows a value it doesn't hold.
 */
function ProjectPreviewCountRow() {
  const { projectPreviewCount, setProjectPreviewCount } = useProjectPreviewCount()
  const options = PREVIEW_COUNT_PRESETS.includes(projectPreviewCount)
    ? PREVIEW_COUNT_PRESETS
    : [...PREVIEW_COUNT_PRESETS, projectPreviewCount].sort((a, b) => a - b)
  return (
    <div className="mt-4 flex items-center justify-between border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <div>
        <div className="text-sm">Tasks shown per project</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">The rest are behind Show all</div>
      </div>
      <select
        aria-label="Tasks shown per project"
        data-project-preview-count-select
        value={projectPreviewCount}
        onChange={(e) =>
          void savePreferenceField(
            'project_preview_count',
            Number(e.target.value),
            projectPreviewCount,
            setProjectPreviewCount,
          )
        }
        className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        {options.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * One project in the sortable list. `full` is the Project behind the list's
 * slimmer SortableProject (color, shared, description). Shared projects get a
 * spacer instead of a drag handle; shared projects and Inbox get no delete
 * button. The description sits under the name (`ProjectDescription`).
 */
function ProjectRow({
  project,
  full,
  dragHandleProps,
  onDelete,
  onSaved,
}: {
  project: SortableProject
  full: Project | undefined
  dragHandleProps: DragHandleProps
  onDelete: (project: Project) => void
  onSaved: () => Promise<void> | void
}) {
  const { data: session } = useSession()
  const isShared = full?.shared ?? false
  const canDelete = !isShared && full?.name !== 'Inbox'
  // PATCH /api/projects/:id is owner-only, so only the owner gets the editor;
  // a member of someone else's shared project sees the description read-only.
  const isOwner = !!full && String(full.owner_id) === session?.user?.id
  // The description being edited (null: not editing). Held here so the
  // "Add description" affordance can sit on the name's line — see
  // `ProjectDescription`.
  const [draft, setDraft] = useState<string | null>(null)
  const canAdd = isOwner && !full?.description && draft === null
  return (
    <div
      data-project-row={project.id}
      className="group rounded-md border border-transparent px-1 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900"
    >
      <div className="flex items-center gap-2">
        {isShared ? (
          <div className="w-4" />
        ) : (
          <DragHandle
            attributes={dragHandleProps.attributes}
            listeners={dragHandleProps.listeners}
          />
        )}
        {full?.color && (
          <span className={`size-2.5 flex-shrink-0 rounded-full ${LABEL_COLORS[full.color].dot}`} />
        )}
        <span className="min-w-0 truncate text-sm">{project.name}</span>
        {canAdd && (
          <button
            type="button"
            data-project-description-add
            onClick={() => setDraft('')}
            className="shrink-0 text-xs text-zinc-400 transition-opacity hover:text-zinc-600 focus-visible:opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 dark:text-zinc-500 dark:hover:text-zinc-300"
          >
            Add description
          </button>
        )}
        <span className="flex-1" />
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
        {/* A row with no delete (the Inbox) keeps the trash's 14px so its
            count lines up with the counts below it. */}
        {!(canDelete && full) && <span aria-hidden className="w-3.5 shrink-0" />}
      </div>
      {full && (
        <ProjectDescription
          project={full}
          editable={isOwner}
          draft={draft}
          setDraft={setDraft}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}

/**
 * A project's description (task-model redesign, 2026-10-10): what belongs in
 * it, read by the AI and by desks that file tasks over the API. Capped at
 * PROJECT_DESCRIPTION_MAX, with a live count while editing.
 *
 * Shown in full under the name, never clipped: it is at most a couple of
 * sentences, and a half-shown definition misleads. Click it to edit. With
 * none, `ProjectRow` offers "Add description" as plain muted text on the
 * name's line — the text is the affordance, no icon (Trent's rule), and it
 * takes no height of its own, so undescribed projects keep the list as tight
 * as before. From `md` up it shows on hover or focus; always on a phone,
 * which has no hover.
 *
 * Saving trims (the API does too); an emptied field clears the description.
 * Escape cancels; Cmd/Ctrl+Enter saves.
 */
function ProjectDescription({
  project,
  editable,
  draft,
  setDraft,
  onSaved,
}: {
  project: Project
  editable: boolean
  draft: string | null
  setDraft: (draft: string | null) => void
  onSaved: () => Promise<void> | void
}) {
  const [saving, setSaving] = useState(false)
  const saved = project.description ?? ''

  const save = async () => {
    if (draft === null || saving) return
    const next = draft.trim()
    if (next === saved) {
      setDraft(null)
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: next || null }),
      })
      if (!res.ok) throw new Error('Failed to save')
      await onSaved()
      setDraft(null)
      showToast({ message: next ? 'Description saved' : 'Description cleared', type: 'success' })
    } catch {
      showToast({ message: 'Failed to save description', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  if (draft !== null) {
    return (
      <div className="mt-1.5 ml-6" data-project-description-editor>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(null)
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void save()
            }
          }}
          maxLength={PROJECT_DESCRIPTION_MAX}
          rows={2}
          autoFocus
          aria-label={`Description of ${project.name}`}
          placeholder="What belongs here, e.g. “Client work for Acme: calls, invoices, deliverables”"
          className="text-sm"
          disabled={saving}
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-xs text-zinc-400 tabular-nums" data-project-description-count>
            {draft.length}/{PROJECT_DESCRIPTION_MAX}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => void save()}
              disabled={saving || draft.trim() === saved}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (!saved) return null
  // The text size and leading on the element itself: an inline span inside a
  // block left the button's own line height between wrapped lines.
  const textClass =
    'mt-0.5 ml-6 block text-left text-xs leading-snug whitespace-pre-wrap text-zinc-500 dark:text-zinc-400'
  if (!editable) return <div className={textClass}>{saved}</div>
  return (
    <button
      type="button"
      data-project-description
      onClick={() => setDraft(saved)}
      data-project-description-of={project.name}
      className={`${textClass} cursor-text rounded`}
    >
      {/* The description is the button's name, so a screen reader hears it;
          the prefix says what a press does. */}
      <span className="sr-only">Edit description: </span>
      {saved}
    </button>
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
