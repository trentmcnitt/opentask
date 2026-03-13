'use client'

import { GuardedLink } from './GuardedLink'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, History, Archive, Trash2, Settings, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BUILD_ID, VERSION, formatBuildDate } from '@/lib/build-info'
import { Button } from '@/components/ui/button'

interface SidebarProps {
  onAddClick?: () => void
}

export function Sidebar({ onAddClick }: SidebarProps) {
  const pathname = usePathname()

  const navItems = [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard },
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
