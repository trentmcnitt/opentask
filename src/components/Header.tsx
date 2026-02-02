'use client'

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
            <Popover>
              <PopoverTrigger asChild>
                <div
                  className="flex flex-shrink-0 cursor-pointer items-center gap-1"
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
                  <span>{taskCount} tasks</span>
                  {overdueCount > 0 && (
                    <span className="text-destructive">{overdueCount} overdue</span>
                  )}
                  {todayCount > 0 && <span className="text-primary">{todayCount} due today</span>}
                </div>
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex items-center gap-1">
            {/* Search */}
            {onSearch && onSearchClear && <SearchBar onSearch={onSearch} onClear={onSearchClear} />}

            {/* Grouping toggle (desktop only) */}
            {onGroupingChange && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onGroupingChange(grouping === 'time' ? 'project' : 'time')}
                    aria-label={`Group by ${grouping === 'time' ? 'project' : 'time'}`}
                    className="hidden md:inline-flex"
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

            {/* Undo button (desktop only) */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onUndo}
                  aria-label="Undo last action"
                  className="hidden md:inline-flex"
                >
                  <Undo2 className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
            </Tooltip>

            {/* Sign out button (desktop only) */}
            {userName && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => signOut({ callbackUrl: '/login' })}
                    aria-label={`Sign out ${userName}`}
                    className="hidden md:inline-flex"
                  >
                    <LogOut className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Sign out ({userName})</TooltipContent>
              </Tooltip>
            )}

            {/* Hamburger menu (mobile only) */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Menu" className="md:hidden">
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
