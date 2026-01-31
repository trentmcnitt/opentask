'use client'

import { signOut } from 'next-auth/react'
import type { GroupingMode } from './TaskList'
import { SearchBar } from './SearchBar'

interface HeaderProps {
  taskCount: number
  overdueCount?: number
  grouping?: GroupingMode
  onGroupingChange?: (mode: GroupingMode) => void
  onUndo: () => void
  onSearch?: (query: string) => void
  onSearchClear?: () => void
  userName?: string
}

export function Header({ taskCount, overdueCount = 0, grouping = 'time', onGroupingChange, onUndo, onSearch, onSearchClear, userName }: HeaderProps) {
  return (
    <header className="sticky top-0 z-10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm border-b border-zinc-200 dark:border-zinc-800">
      <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">OpenTask</h1>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            {taskCount} tasks
          </span>
          {overdueCount > 0 && (
            <span className="inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-bold text-white bg-red-500 rounded-full min-w-[20px]">
              {overdueCount}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Search */}
          {onSearch && onSearchClear && (
            <SearchBar onSearch={onSearch} onClear={onSearchClear} />
          )}

          {/* Grouping toggle */}
          {onGroupingChange && (
            <button
              onClick={() => onGroupingChange(grouping === 'time' ? 'project' : 'time')}
              aria-label={`Group by ${grouping === 'time' ? 'project' : 'time'}`}
              className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              title={`Group by ${grouping === 'time' ? 'project' : 'time'}`}
            >
              {grouping === 'time' ? (
                /* Folder icon for switching to project view */
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                </svg>
              ) : (
                /* Clock icon for switching to time view */
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              )}
            </button>
          )}

          {/* Undo button */}
          <button
            onClick={onUndo}
            aria-label="Undo last action"
            className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            title="Undo (Ctrl+Z)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7v6h6" />
              <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
            </svg>
          </button>

          {/* Sign out button */}
          {userName && (
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              aria-label={`Sign out ${userName}`}
              className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              title={`Sign out (${userName})`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
