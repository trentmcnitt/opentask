'use client'

import Image from 'next/image'
import { signOut } from 'next-auth/react'
import { FolderOpen, Clock, Undo2, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { GroupingMode } from './TaskList'
import { SearchBar } from './SearchBar'

interface HeaderProps {
  taskCount: number
  overdueCount?: number
  todayCount?: number
  grouping?: GroupingMode
  onGroupingChange?: (mode: GroupingMode) => void
  onUndo: () => void
  onSearch?: (query: string) => void
  onSearchClear?: () => void
  userName?: string
}

export function Header({
  taskCount,
  overdueCount = 0,
  todayCount = 0,
  grouping = 'time',
  onGroupingChange,
  onUndo,
  onSearch,
  onSearchClear,
  userName,
}: HeaderProps) {
  return (
    <TooltipProvider delayDuration={300}>
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <Image
              src="/opentask-logo.png"
              alt="OpenTask"
              width={120}
              height={36}
              className="h-7 w-auto flex-shrink-0 md:h-9 dark:invert"
              unoptimized
              priority
            />
            <div className="flex flex-shrink-0 items-center gap-1">
              <span className="bg-muted text-muted-foreground inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium">
                {taskCount}
              </span>
              {overdueCount > 0 && (
                <span className="bg-destructive/15 text-destructive inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium">
                  {overdueCount}
                </span>
              )}
              {todayCount > 0 && (
                <span className="bg-primary/15 text-primary inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium">
                  {todayCount}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1">
            {/* Search */}
            {onSearch && onSearchClear && <SearchBar onSearch={onSearch} onClear={onSearchClear} />}

            {/* Grouping toggle */}
            {onGroupingChange && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onGroupingChange(grouping === 'time' ? 'project' : 'time')}
                    aria-label={`Group by ${grouping === 'time' ? 'project' : 'time'}`}
                  >
                    {grouping === 'time' ? (
                      <FolderOpen className="size-5" />
                    ) : (
                      <Clock className="size-5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Group by {grouping === 'time' ? 'project' : 'time'}</TooltipContent>
              </Tooltip>
            )}

            {/* Undo button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={onUndo} aria-label="Undo last action">
                  <Undo2 className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
            </Tooltip>

            {/* Sign out button */}
            {userName && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => signOut({ callbackUrl: '/login' })}
                    aria-label={`Sign out ${userName}`}
                  >
                    <LogOut className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Sign out ({userName})</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </header>
    </TooltipProvider>
  )
}
