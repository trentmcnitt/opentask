'use client'

import { GuardedLink } from './GuardedLink'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, History, Archive, Trash2, Settings, Plus, Lightbulb } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useRemindersBadge } from '@/hooks/useReminders'
import { useTaskNavCounts } from '@/hooks/useTaskNavCounts'
import { useTimezone } from '@/hooks/useTimezone'
import { BUILD_ID, VERSION, formatBuildDate } from '@/lib/build-info'
import { Button } from '@/components/ui/button'

interface SidebarProps {
  onAddClick?: () => void
}

export function Sidebar({ onAddClick }: SidebarProps) {
  const pathname = usePathname()

  // Desktop has room for every destination, so nothing hides behind a menu here —
  // the split is "where you work" on top, "where things end up" pinned at the
  // bottom. Reminders (§6) belongs to the first group: it is a daily surface, not
  // an archive of anything.
  // §6: the reminders badge is "waiting so far today" — never overdue, never
  // red. Same number the Reminders headline shows.
  const remindersWaiting = useRemindersBadge(useTimezone())
  // Tasks carries the top bar's overdue (red) and due-today (blue) numbers, so
  // the other surface is visible from here.
  const taskCounts = useTaskNavCounts()

  const navItems = [
    { href: '/', label: 'Tasks', icon: LayoutDashboard },
    { href: '/reminders', label: 'Reminders', icon: Lightbulb },
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
              <GuardedLink
                key={item.href}
                href={item.href}
                onClick={
                  item.href === '/' && isActive
                    ? (e: React.MouseEvent<HTMLAnchorElement>) => {
                        e.preventDefault()
                        window.dispatchEvent(new CustomEvent('dashboard-reset'))
                      }
                    : undefined
                }
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon className="size-4" />
                {item.label}
                {item.href === '/' &&
                  taskCounts &&
                  (taskCounts.overdue > 0 || taskCounts.today > 0) && (
                    <span className="ml-auto flex items-center gap-1" data-tasks-badge>
                      {taskCounts.overdue > 0 && (
                        <span
                          className="bg-destructive/15 text-destructive rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                          aria-label={`${taskCounts.overdue} overdue`}
                        >
                          {taskCounts.overdue}
                        </span>
                      )}
                      {taskCounts.today > 0 && (
                        <span
                          className="bg-primary/15 text-primary rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                          aria-label={`${taskCounts.today} due today`}
                        >
                          {taskCounts.today}
                        </span>
                      )}
                    </span>
                  )}
                {item.href === '/reminders' && remindersWaiting > 0 && (
                  <span
                    data-reminders-badge
                    className="bg-foreground/10 text-foreground/80 ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                    aria-label={`${remindersWaiting} reminders waiting so far today`}
                  >
                    {remindersWaiting}
                  </span>
                )}
              </GuardedLink>
            )
          })}
        </div>

        {/* Build info - at bottom of scrollable nav area */}
        <div className="mt-auto pt-4 text-center">
          <span className="text-muted-foreground/60 text-[11px]">
            v{VERSION} · {formatBuildDate(BUILD_ID)}
          </span>
          <br />
          <a
            href="https://mcnitt.io"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground/40 hover:text-muted-foreground/70 text-[10px] transition-colors"
          >
            mcnitt.io
          </a>
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
            <GuardedLink
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
            </GuardedLink>
          )
        })}
      </div>
    </aside>
  )
}
