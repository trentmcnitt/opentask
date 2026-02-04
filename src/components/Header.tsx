'use client'

import { useState } from 'react'
import Image from 'next/image'
import { signOut } from 'next-auth/react'
import { FolderOpen, Clock, Undo2, LogOut, Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { BUILD_ID, VERSION, formatBuildDate } from '@/lib/build-info'
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
  onSnoozeOverdue?: () => void
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
  onSnoozeOverdue,
}: HeaderProps) {
  const [searchExpanded, setSearchExpanded] = useState(false)

  return (
    <TooltipProvider delayDuration={300}>
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="relative mx-auto flex max-w-2xl items-center gap-1.5 px-4 py-3 md:gap-2">
          {/* Logo with build info popover */}
          <Popover>
            <PopoverTrigger asChild>
              <Image
                src="/opentask-logo.png"
                alt="OpenTask"
                width={120}
                height={36}
                className={cn(
                  'h-7 w-auto flex-shrink-0 cursor-pointer transition-opacity duration-200 md:h-9 dark:invert',
                  searchExpanded ? 'opacity-0 md:opacity-100' : '',
                )}
                unoptimized
                priority
              />
            </PopoverTrigger>
            <PopoverContent className="w-auto px-3 py-2 text-xs" sideOffset={6}>
              v{VERSION} · {formatBuildDate(BUILD_ID)}
            </PopoverContent>
          </Popover>

          {/* Middle section: badges + search. flex-1 keeps buttons fixed. */}
          <div className="flex min-w-0 flex-1 items-center">
            {/* Badges: fade + collapse when search expanded */}
            <Popover>
              <PopoverTrigger asChild>
                <div
                  className={cn(
                    'flex flex-shrink-0 cursor-pointer items-center gap-1 transition-[opacity,max-width] duration-200',
                    searchExpanded
                      ? 'pointer-events-none opacity-0 md:max-w-0 md:overflow-hidden'
                      : 'max-w-[12rem] opacity-100',
                  )}
                  role="group"
                  aria-label="Task counts"
                  tabIndex={0}
                >
                  <span className="bg-muted text-muted-foreground inline-flex min-w-[1.25rem] items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-medium select-none">
                    {taskCount}
                  </span>
                  {overdueCount > 0 && (
                    <span className="bg-destructive/15 text-destructive inline-flex min-w-[1.25rem] items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-medium select-none">
                      {overdueCount}
                    </span>
                  )}
                  {todayCount > 0 && (
                    <span className="bg-primary/15 text-primary inline-flex min-w-[1.25rem] items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-medium select-none">
                      {todayCount}
                    </span>
                  )}
                </div>
              </PopoverTrigger>
              <PopoverContent className="w-auto px-3 py-2 text-xs" sideOffset={6}>
                <div className="flex flex-col gap-1">
                  <span>{taskCount} total</span>
                  {overdueCount > 0 && (
                    <span className="text-destructive">{overdueCount} overdue</span>
                  )}
                  {todayCount > 0 && <span className="text-primary">{todayCount} due today</span>}
                </div>
              </PopoverContent>
            </Popover>

            {/* Search: ml-auto keeps it right-aligned, expands leftward */}
            {onSearch && onSearchClear && (
              <SearchBar
                onSearch={onSearch}
                onClear={onSearchClear}
                onExpandedChange={setSearchExpanded}
              />
            )}
          </div>

          {/* Action buttons: always fixed in place */}
          <div className="flex flex-shrink-0 items-center">
            {/* Snooze all overdue button */}
            {onSnoozeOverdue && overdueCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onSnoozeOverdue}
                    aria-label="Snooze all overdue +1h"
                  >
                    <Clock className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Snooze all overdue +1h</TooltipContent>
              </Tooltip>
            )}

            {/* Hamburger menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Menu">
                  <Menu className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onGroupingChange && (
                  <DropdownMenuItem
                    onClick={() => onGroupingChange(grouping === 'time' ? 'project' : 'time')}
                  >
                    {grouping === 'time' ? (
                      <FolderOpen className="size-4" />
                    ) : (
                      <Clock className="size-4" />
                    )}
                    Group by {grouping === 'time' ? 'project' : 'time'}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onUndo}>
                  <Undo2 className="size-4" />
                  Undo
                </DropdownMenuItem>
                {userName && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => signOut({ callbackUrl: '/login' })}>
                      <LogOut className="size-4" />
                      Sign out ({userName})
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
    </TooltipProvider>
  )
}
