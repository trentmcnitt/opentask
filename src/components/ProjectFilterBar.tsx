'use client'

import { useMemo } from 'react'
import { FolderOpen } from 'lucide-react'
import { LABEL_COLORS } from '@/lib/label-colors'
import { EXCLUDED_CHIP_CLASSES } from '@/lib/priority'
import { cn } from '@/lib/utils'
import { useChipInteraction, type ChipState } from '@/hooks/useChipInteraction'
import type { Task, Project } from '@/types'

interface ProjectFilterBarProps {
  projects: Project[]
  tasks: Task[]
  selectedProjects: number[]
  excludedProjects?: number[]
  onToggleProject: (projectId: number) => void
  onExclusiveProject?: (projectId: number) => void
  onExcludeProject?: (projectId: number) => void
  todayCounts?: Map<number, number>
}

/**
 * Project filter chips with folder icon and neutral styling when unselected.
 *
 * Unselected: neutral outline with folder icon (colored if project has a color).
 * Selected: full colored background with folder icon.
 * Excluded: red strikethrough styling (uniform with other chip types).
 *
 * Layout: flex-wrap so all projects are always visible (never scrollable).
 * Interaction: click to toggle, double-click to exclude, Cmd+click or 400ms long-press for exclusive select.
 * Requires 2+ projects with tasks to render.
 */
export function ProjectFilterBar({
  projects,
  tasks,
  selectedProjects,
  excludedProjects = [],
  onToggleProject,
  onExclusiveProject,
  onExcludeProject,
  todayCounts: _todayCounts,
}: ProjectFilterBarProps) {
  const projectCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const task of tasks) {
      counts.set(task.project_id, (counts.get(task.project_id) || 0) + 1)
    }
    return projects
      .filter(
        (p) =>
          counts.has(p.id) || selectedProjects.includes(p.id) || excludedProjects.includes(p.id),
      )
      .map((p) => ({ project: p, count: counts.get(p.id) ?? 0 }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        return a.project.sort_order - b.project.sort_order
      })
  }, [projects, tasks, selectedProjects, excludedProjects])

  const hasActiveProjectFilter = selectedProjects.length > 0 || excludedProjects.length > 0
  if (projectCounts.length < 2 && !hasActiveProjectFilter) return null

  return (
    <div className="flex flex-wrap gap-2">
      {projectCounts.map(({ project, count }) => {
        const chipState: ChipState = excludedProjects.includes(project.id)
          ? 'excluded'
          : selectedProjects.includes(project.id)
            ? 'included'
            : 'unselected'
        const colorDef = project.color ? LABEL_COLORS[project.color] : null
        const overdueCount = project.overdue_count ?? 0

        return (
          <ProjectChip
            key={project.id}
            projectId={project.id}
            name={project.name}
            totalCount={count}
            overdueCount={overdueCount}
            chipState={chipState}
            colorDef={colorDef}
            onToggle={onToggleProject}
            onExclusive={onExclusiveProject}
            onExclude={onExcludeProject}
          />
        )
      })}
    </div>
  )
}

function ProjectChip({
  projectId,
  name,
  totalCount,
  overdueCount,
  chipState,
  colorDef,
  onToggle,
  onExclusive,
  onExclude,
}: {
  projectId: number
  name: string
  totalCount: number
  overdueCount: number
  chipState: ChipState
  colorDef: { bg: string; text: string; dot: string; border: string } | null
  onToggle: (projectId: number) => void
  onExclusive?: (projectId: number) => void
  onExclude?: (projectId: number) => void
}) {
  const handlers = useChipInteraction({
    chipKey: projectId,
    chipState,
    onToggle,
    onExclusive,
    onExclude,
  })

  return (
    <button
      onClick={handlers.onClick}
      onPointerDown={handlers.onPointerDown}
      onPointerUp={handlers.onPointerUp}
      onPointerMove={handlers.onPointerMove}
      onPointerLeave={handlers.onPointerLeave}
      className={cn(
        'relative flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors select-none',
        chipState === 'excluded'
          ? EXCLUDED_CHIP_CLASSES
          : chipState === 'included'
            ? colorDef
              ? `${colorDef.bg} ${colorDef.text} border-transparent`
              : 'border-transparent bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
            : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      <span
        className={cn(
          'flex items-center gap-1',
          chipState !== 'excluded' && chipState !== 'included' && colorDef && colorDef.text,
        )}
      >
        <FolderOpen className="size-3" />
        <span className="max-w-[8rem] truncate">{name}</span>
      </span>
      <span className="text-[10px] leading-none opacity-60">{totalCount}</span>
      {overdueCount > 0 && (
        <span className="bg-badge-destructive absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold text-white">
          {overdueCount}
        </span>
      )}
    </button>
  )
}
