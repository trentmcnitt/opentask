'use client'

import { GuardedLink } from './GuardedLink'
import { usePathname } from 'next/navigation'
import { LayoutGrid, Archive, Plus, Clock, Settings } from 'lucide-react'

interface BottomTabsProps {
  onAddClick?: () => void
}

export function BottomTabs({ onAddClick }: BottomTabsProps) {
  const pathname = usePathname()

  const tabs = [
    { href: '/', label: 'Dashboard', icon: LayoutGrid },
    { href: '/archive', label: 'Archive', icon: Archive },
    { href: '#add', label: 'Add', icon: Plus, isAction: true },
    { href: '/history', label: 'History', icon: Clock },
    { href: '/settings', label: 'Settings', icon: Settings },
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
              <Icon className="h-5 w-5" />
              <span className="mt-0.5 text-[10px]">{tab.label}</span>
            </GuardedLink>
          )
        })}
      </div>
    </nav>
  )
}
