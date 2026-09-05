'use client'

import { GuardedLink } from './GuardedLink'
import { usePathname } from 'next/navigation'
import { LayoutGrid, Archive, Plus, Clock, Lightbulb } from 'lucide-react'
import { useRemindersBadge } from '@/hooks/useReminders'
import { useTaskNavCounts } from '@/hooks/useTaskNavCounts'
import { useTimezone } from '@/hooks/useTimezone'

interface BottomTabsProps {
  onAddClick?: () => void
}

/**
 * Mobile tab bar.
 *
 * Reminders (§6) is a destination, not a setting, so it takes a tab; Settings and
 * Trash moved into the dashboard header's menu, which is the only overflow surface
 * mobile has. Five slots is the ceiling — the centre one is the Add action, so four
 * destinations is all there is to allocate.
 */
export function BottomTabs({ onAddClick }: BottomTabsProps) {
  const pathname = usePathname()
  // §6: reminders waiting so far today — never overdue, never red.
  const remindersWaiting = useRemindersBadge(useTimezone())
  // One badge fits a tab: overdue (red) when there is any, else due today (blue).
  const taskCounts = useTaskNavCounts()
  const tasksBadge =
    taskCounts && taskCounts.overdue > 0
      ? { n: taskCounts.overdue, label: `${taskCounts.overdue} overdue`, tone: 'overdue' }
      : taskCounts && taskCounts.today > 0
        ? { n: taskCounts.today, label: `${taskCounts.today} due today`, tone: 'today' }
        : null

  const tabs = [
    { href: '/', label: 'Tasks', icon: LayoutGrid },
    // Lightbulb is the Reminders surface's own icon (see RemindersView's empty state).
    { href: '/reminders', label: 'Reminders', icon: Lightbulb },
    { href: '#add', label: 'Add', icon: Plus, isAction: true },
    { href: '/history', label: 'History', icon: Clock },
    { href: '/archive', label: 'Archive', icon: Archive },
  ]

  return (
    <nav className="safe-bottom border-border bg-background fixed right-0 bottom-0 left-0 z-20 border-t select-none md:hidden">
      <div className="flex items-center justify-around px-2 pt-1">
        {tabs.map((tab) => {
          const isActive =
            tab.href === '/'
              ? pathname === '/'
              : pathname.startsWith(tab.href) && tab.href !== '#add'
          const Icon = tab.icon

          if (tab.isAction) {
            return (
              <button
                key={tab.label}
                onClick={onAddClick}
                aria-label={tab.label}
                className="-mt-3 flex flex-col items-center justify-center p-2"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500 shadow-lg">
                  <Icon className="h-6 w-6 text-white" strokeWidth={2.5} />
                </div>
              </button>
            )
          }

          return (
            <GuardedLink
              key={tab.label}
              href={tab.href}
              aria-label={tab.label}
              onClick={
                tab.href === '/' && isActive
                  ? (e: React.MouseEvent<HTMLAnchorElement>) => {
                      e.preventDefault()
                      window.dispatchEvent(new CustomEvent('dashboard-reset'))
                    }
                  : undefined
              }
              className={`flex min-w-[48px] flex-col items-center justify-center rounded-lg p-2 ${
                isActive ? 'text-blue-500' : 'text-muted-foreground'
              }`}
            >
              <span className="relative">
                <Icon className="h-5 w-5" />
                {tab.href === '/' && tasksBadge && (
                  <span
                    data-tasks-badge
                    className={`absolute -top-1.5 -right-3 rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums ${
                      tasksBadge.tone === 'overdue'
                        ? 'bg-destructive/15 text-destructive'
                        : 'bg-primary/15 text-primary'
                    }`}
                    aria-label={tasksBadge.label}
                  >
                    {tasksBadge.n}
                  </span>
                )}
                {tab.href === '/reminders' && remindersWaiting > 0 && (
                  <span
                    data-reminders-badge
                    className="bg-foreground/10 text-foreground/80 absolute -top-1.5 -right-3 rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums"
                    aria-label={`${remindersWaiting} reminders waiting so far today`}
                  >
                    {remindersWaiting}
                  </span>
                )}
              </span>
              <span className="mt-0.5 text-[10px]">{tab.label}</span>
            </GuardedLink>
          )
        })}
      </div>
    </nav>
  )
}
