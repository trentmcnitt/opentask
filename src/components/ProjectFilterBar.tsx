'use client'

import { useMemo } from 'react'
import { FolderOpen, Check } from 'lucide-react'
import { LABEL_COLORS } from '@/lib/label-colors'
import { EXCLUDED_CHIP_CLASSES } from '@/lib/priority'
import { cn } from '@/lib/utils'
import { computeCompletionFill, type CompletionFill } from '@/lib/completion-fill'
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
  /** Due-today, not-yet-done per project — completion fill denominator (§ITEM 2). */
  todayCounts?: Map<number, number>
  /** Completed today per project — completion fill numerator (§ITEM 2). */
  doneTodayByProject?: Map<number, number>
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
  todayCounts,
  doneTodayByProject,
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
        // Excluded reads as "not this" — a fill would fight that message.
        //
        // A missing MAP (undefined) means the caller didn't wire completion
        // data at all — pass that through as "no fill" (computeCompletionFill
        // treats undefined as "no data yet"). A missing KEY in a map that DOES
        // exist means this project simply has zero for that count (it never
        // gets an entry when it has nothing due today, or nothing done today)
        // — that must coalesce to 0, or a fully-finished project (0 remaining)
        // reads as "no data" and never shows its green fill.
        const doneToday = doneTodayByProject ? (doneTodayByProject.get(project.id) ?? 0) : undefined
        const remainingToday = todayCounts ? (todayCounts.get(project.id) ?? 0) : undefined
        const fill =
          chipState === 'excluded' ? null : computeCompletionFill(doneToday, remainingToday)

        return (
          <ProjectChip
            key={project.id}
            projectId={project.id}
            name={project.name}
            totalCount={count}
            overdueCount={overdueCount}
            chipState={chipState}
            colorDef={colorDef}
            fill={fill}
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
  fill,
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
  /** Completion fill (§ITEM 2) — null for the excluded state. */
  fill?: CompletionFill | null
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
  // The "included" chip's own background is a light/pastel colour in light
  // mode and a dark translucent one in dark mode (LABEL_COLORS, or the
  // neutral gray-200/gray-700 fallback below) — the inverse of most chips —
  // so its fill overlay is a plain shade (dark in light mode, light in dark
  // mode) rather than teal, which would barely register against a pastel and
  // would clash with the project's own colour either way.
  const fillClass = fill
    ? chipState === 'included'
      ? fill.finished
        ? 'bg-green-500/30 dark:bg-green-400/30'
        : 'bg-black/10 dark:bg-white/15'
      : fill.finished
        ? 'bg-green-500/25 dark:bg-green-400/25'
        : 'bg-teal-500/25 dark:bg-teal-400/25'
    : null

  return (
    <button
      onClick={handlers.onClick}
      onPointerDown={handlers.onPointerDown}
      onPointerUp={handlers.onPointerUp}
      onPointerMove={handlers.onPointerMove}
      onPointerLeave={handlers.onPointerLeave}
      data-project-chip={projectId}
      data-project-chip-finished={fill?.finished ? '' : undefined}
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
      {/* Clipped to its own wrapper (not the button) so the overdue badge
          below, which deliberately hangs outside the button's border box,
          never gets cut off by the fill's own overflow-hidden. */}
      {fillClass && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg"
        >
          <span
            className={cn(
              'absolute inset-y-0 left-0 transition-[width] duration-300 ease-out',
              fillClass,
            )}
            style={{ width: `${fill!.fraction * 100}%` }}
          />
        </span>
      )}
      <span
        className={cn(
          'relative flex items-center gap-1',
          chipState !== 'excluded' && chipState !== 'included' && colorDef && colorDef.text,
        )}
      >
        <FolderOpen className="size-3" />
        <span className="max-w-[8rem] truncate">{name}</span>
      </span>
      <span className="relative text-[10px] leading-none opacity-60">{totalCount}</span>
      {fill?.finished && (
        <Check
          aria-hidden="true"
          className={cn(
            'relative size-3',
            chipState === 'included' ? 'opacity-90' : 'text-green-600 dark:text-green-400',
          )}
          strokeWidth={2.5}
        />
      )}
      {overdueCount > 0 && (
        <span className="bg-badge-destructive absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold text-white">
          {overdueCount}
        </span>
      )}
    </button>
  )
}
