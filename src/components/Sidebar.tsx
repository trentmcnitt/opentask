'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  History,
  Archive,
  Trash2,
  Settings,
  Circle,
  Plus,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { BUILD_ID, VERSION, formatBuildDate } from '@/lib/build-info'
import { Button } from '@/components/ui/button'
import {
  SortableProjectList,
  DragHandle,
  type DragHandleProps,
} from '@/components/SortableProjectList'
import { CountBadge } from '@/components/CountBadge'

interface SidebarProject {
  id: number
  name: string
  active_count: number
  overdue_count: number
}

interface SidebarProps {
  projects?: SidebarProject[]
  onAddClick?: () => void
  onReorderProjects?: (projectIds: number[]) => void
}

export function Sidebar({ projects = [], onAddClick, onReorderProjects }: SidebarProps) {
  const pathname = usePathname()

  const navItems = [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/review', label: 'AI Review', icon: Sparkles },
    { href: '/history', label: 'History', icon: History },
  ]

  const bottomNavItems = [
    { href: '/archive', label: 'Archive', icon: Archive },
    { href: '/trash', label: 'Trash', icon: Trash2 },
    { href: '/settings', label: 'Settings', icon: Settings },
  ]

  return (
    <aside className="bg-muted/50 sticky top-0 hidden h-screen w-56 flex-shrink-0 flex-col border-r select-none md:flex">
      {/* Navigation */}
      <nav className="flex flex-1 flex-col overflow-y-auto px-2 py-3">
        <div className="space-y-1">
          {navItems.map((item) => {
            const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
            const Icon = item.icon

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            )
          })}

          {/* Projects section */}
          {projects.length > 0 && (
            <div className="pt-4">
              <h3 className="text-muted-foreground mb-1 px-3 text-xs font-semibold tracking-wider uppercase">
                Projects
              </h3>
              {onReorderProjects ? (
                <SortableProjectList
                  projects={projects}
                  onReorder={onReorderProjects}
                  renderItem={(project, dragHandle) => {
                    const fullProject = projects.find((p) => p.id === project.id)
                    return (
                      <SidebarProjectItem
                        project={fullProject || { ...project, active_count: 0, overdue_count: 0 }}
                        pathname={pathname}
                        dragHandle={dragHandle}
                      />
                    )
                  }}
                />
              ) : (
                projects.map((project) => (
                  <SidebarProjectItem key={project.id} project={project} pathname={pathname} />
                ))
              )}
            </div>
          )}
        </div>

        {/* Build info - at bottom of scrollable nav area */}
        <div className="mt-auto pt-4 text-center">
          <span className="text-muted-foreground/60 text-[11px]">
            v{VERSION} · {formatBuildDate(BUILD_ID)}
          </span>
        </div>
      </nav>

      {/* Add Task button */}
      {onAddClick && (
        <div className="border-t px-2 py-3">
          <Button variant="outline" className="w-full justify-start gap-2" onClick={onAddClick}>
            <Plus className="size-4" />
            Add Task
          </Button>
        </div>
      )}

      {/* Pinned bottom nav — outside scrollable area */}
      <div className="space-y-1 border-t px-2 py-3">
        {bottomNavItems.map((item) => {
          const isActive = pathname.startsWith(item.href)
          const Icon = item.icon

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          )
        })}
      </div>
    </aside>
  )
}

function SidebarProjectItem({
  project,
  pathname,
  dragHandle,
}: {
  project: SidebarProject
  pathname: string
  dragHandle?: DragHandleProps
}) {
  const href = `/projects/${project.id}`
  const isActive = pathname === href

  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-lg text-sm transition-colors',
        isActive
          ? 'bg-accent text-accent-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        dragHandle?.isDragging && 'bg-accent shadow-sm',
      )}
    >
      {dragHandle && (
        <DragHandle
          attributes={dragHandle.attributes}
          listeners={dragHandle.listeners}
          className="ml-1 opacity-0 group-hover:opacity-100"
        />
      )}
      <Link
        href={href}
        className={cn('flex flex-1 items-center gap-3 py-2 pr-3', dragHandle ? 'pl-0' : 'pl-3')}
      >
        <Circle className="size-4 flex-shrink-0" />
        <span className="truncate">{project.name}</span>
        <span className="ml-auto flex flex-shrink-0 items-center gap-1">
          <CountBadge count={project.active_count} />
          {project.overdue_count > 0 && (
            <CountBadge count={project.overdue_count} variant="overdue" />
          )}
        </span>
      </Link>
    </div>
  )
}
