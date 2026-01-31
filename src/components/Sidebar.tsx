'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface SidebarProps {
  projects?: { id: number; name: string }[]
}

export function Sidebar({ projects = [] }: SidebarProps) {
  const pathname = usePathname()

  const navItems = [
    { href: '/', label: 'Dashboard', icon: '□' },
    { href: '/history', label: 'History', icon: '◷' },
    { href: '/settings', label: 'Settings', icon: '⚙' },
  ]

  return (
    <aside className="hidden md:flex flex-col w-56 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 h-screen sticky top-0">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-zinc-200 dark:border-zinc-800">
        <h1 className="text-lg font-semibold">OpenTask</h1>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = item.href === '/'
            ? pathname === '/'
            : pathname.startsWith(item.href)

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </Link>
          )
        })}

        {/* Projects section */}
        {projects.length > 0 && (
          <div className="pt-4">
            <h3 className="px-3 mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Projects
            </h3>
            {projects.map((project) => {
              const href = `/projects/${project.id}`
              const isActive = pathname === href

              return (
                <Link
                  key={project.id}
                  href={href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive
                      ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium'
                      : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900'
                  }`}
                >
                  <span className="text-base">○</span>
                  {project.name}
                </Link>
              )
            })}
          </div>
        )}
      </nav>
    </aside>
  )
}
