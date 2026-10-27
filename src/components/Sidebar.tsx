'use client'

import { OVERDUE_LOWER } from '@/lib/task-model-words'
import { GuardedLink } from './GuardedLink'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  History,
  Archive,
  Trash2,
  Settings,
  Plus,
  Lightbulb,
  Gauge,
  BookOpen,
  ListChecks,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { DOCS_URL } from '@/lib/docs-url'
import { useRemindersBadge } from '@/hooks/useReminders'
import { useTaskNavCounts } from '@/hooks/useTaskNavCounts'
import { useDashboardTabClick } from '@/hooks/useDashboardTabClick'
import { useTimezone } from '@/hooks/useTimezone'
import { BUILD_ID, VERSION, formatBuildDate } from '@/lib/build-info'
import { Button } from '@/components/ui/button'
import { useNavigationGuard } from '@/components/NavigationGuardProvider'
import { addActionLabel } from '@/lib/add-action'
import { PROCESS_ACTION, requestOpenProcess } from '@/lib/process-client'
import { requestNavFilter, type NavFilter } from '@/lib/nav-filter'

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
  const onDashboardClick = useDashboardTabClick()

  const navItems = [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/reminders', label: 'Reminders', icon: Lightbulb },
    // §5: quotas are a place, not only the instrument on the dashboard —
    // somewhere to make one, retire one, and see which have never been met.
    { href: '/quotas', label: 'Quotas', icon: Gauge },
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

            const badges =
              item.href === '/' &&
              taskCounts &&
              (taskCounts.overdue > 0 || taskCounts.today > 0) ? (
                <DashboardCountBadges
                  overdue={taskCounts.overdue}
                  today={taskCounts.today}
                  onDashboard={pathname === '/'}
                />
              ) : null

            return (
              <div key={item.href} className="relative">
                <GuardedLink
                  href={item.href}
                  onClick={item.href === '/' ? onDashboardClick : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  {item.label}
                  {item.href === '/reminders' && remindersWaiting > 0 && (
                    <span
                      data-reminders-badge
                      className="bg-badge-reminders text-destructive-foreground ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                      aria-label={`${remindersWaiting} reminders waiting so far today`}
                    >
                      {remindersWaiting}
                    </span>
                  )}
                </GuardedLink>
                {badges}
              </div>
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
            href="https://www.trentmcnitt.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground/40 hover:text-muted-foreground/70 text-[10px] transition-colors"
          >
            trentmcnitt.com
          </a>
        </div>
      </nav>

      {/* Add Task button */}
      {onAddClick && (
        <div className="border-t px-2 py-3">
          <Button variant="outline" className="w-full justify-start gap-2" onClick={onAddClick}>
            <Plus className="size-4" />
            {addActionLabel(pathname)}
          </Button>
        </div>
      )}

      {/* Process (2026-10-14, mockup P1): its own block between dividers,
          below Add Task — "Add Task and Process are not in the same cage".
          A plain nav-weight row: no count, no subtitle (Trent: "I don't like
          the count… don't think we need all that text"). Shown on every page;
          see `SidebarProcessButton` for how it opens off the dashboard. */}
      <div className="border-t px-2 py-3">
        <SidebarProcessButton />
      </div>

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
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors"
        >
          <BookOpen className="size-4" />
          Docs
        </a>
      </div>
    </aside>
  )
}

/**
 * The left bar's Process — the one Process modal the ☰ menu opens, which lives
 * in the top bar (`Header`). On the dashboard, Reminders and Quotas the top bar
 * is mounted and opens it in place; on a page without one (History, Settings,
 * …) nothing answers the event, so it goes to the dashboard with
 * `?action=process` and the top bar opens it there (`requestOpenProcess`,
 * `PROCESS_ACTION` in src/lib/process-client.ts).
 */
function SidebarProcessButton() {
  const router = useRouter()
  const { requestNavigation } = useNavigationGuard()
  const onClick = () => {
    if (requestOpenProcess()) return
    const href = `/?action=${PROCESS_ACTION}`
    if (requestNavigation(href)) router.push(href)
  }
  return (
    <button
      type="button"
      data-sidebar-process
      onClick={onClick}
      className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors"
    >
      <ListChecks className="size-4" />
      Process
    </button>
  )
}

/**
 * The Dashboard row's overdue (purple) and for-today (grey) counts, each a
 * link to the dashboard filtered to exactly those tasks (2026-10-27, Trent;
 * `src/lib/nav-filter.ts`). They sit over the row's right end as siblings of
 * its link — a link can't hold links — so a click on the label still opens
 * the unfiltered dashboard. Off the dashboard each is a `?filter=` link; on it,
 * a request to the mounted page (`requestNavFilter`).
 */
function DashboardCountBadges({
  overdue,
  today,
  onDashboard,
}: {
  overdue: number
  today: number
  onDashboard: boolean
}) {
  const badge = (filter: NavFilter, count: number, label: string, colour: string) => (
    <GuardedLink
      href={`/?filter=${filter}`}
      onClick={(e) => {
        if (!onDashboard || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        requestNavFilter(filter)
      }}
      title={label}
      aria-label={label}
      data-tasks-badge-filter={filter}
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums transition-colors',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        colour,
      )}
    >
      {count}
    </GuardedLink>
  )
  return (
    <span
      className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1"
      data-tasks-badge
    >
      {overdue > 0 &&
        badge(
          'overdue',
          overdue,
          `Show ${overdue} ${OVERDUE_LOWER}`,
          'bg-over-target/15 text-over-target hover:bg-over-target/30',
        )}
      {today > 0 &&
        badge(
          'today',
          today,
          `Show ${today} for today`,
          'bg-primary/15 text-primary hover:bg-primary/30',
        )}
    </span>
  )
}
