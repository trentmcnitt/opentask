'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, History, Archive, Trash2, Settings, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SidebarProps {
  projects?: { id: number; name: string }[]
}

export function Sidebar({ projects = [] }: SidebarProps) {
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
    <aside className="hidden md:flex flex-col w-56 flex-shrink-0 border-r bg-muted/50 h-screen sticky top-0">
      {/* Brand */}
      <div className="px-4 py-4 border-b">
        <Image
          src="/opentask-text-logo-abbr.png"
          alt="OpenTask"
          width={120}
          height={32}
          className="dark:invert"
          priority
        />
      </div>

      {/* Scrollable navigation */}
      <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = item.href === '/'
            ? pathname === '/'
            : pathname.startsWith(item.href)
          const Icon = item.icon

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
            <h3 className="px-3 mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Projects
            </h3>
            {projects.map((project) => {
              const href = `/projects/${project.id}`
              const isActive = pathname === href

              return (
                <Link
                  key={project.id}
                  href={href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Circle className="size-4" />
                  {project.name}
                </Link>
              )
            })}
          </div>
        )}
      </nav>

      {/* Pinned bottom nav — outside scrollable area */}
      <div className="px-2 py-3 space-y-1 border-t">
        {bottomNavItems.map((item) => {
          const isActive = pathname.startsWith(item.href)
          const Icon = item.icon

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
