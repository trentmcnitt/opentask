'use client'

import { signOut } from 'next-auth/react'
import { FolderOpen, Clock, Undo2, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
    <TooltipProvider delayDuration={300}>
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm border-b">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">OpenTask</h1>
            <span className="text-sm text-muted-foreground">
              {taskCount} tasks
            </span>
            {overdueCount > 0 && (
              <Badge variant="destructive" className="min-w-[20px] justify-center">
                {overdueCount}
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-1">
            {/* Search */}
            {onSearch && onSearchClear && (
              <SearchBar onSearch={onSearch} onClear={onSearchClear} />
            )}

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
                <TooltipContent>
                  Group by {grouping === 'time' ? 'project' : 'time'}
                </TooltipContent>
              </Tooltip>
            )}

            {/* Undo button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onUndo}
                  aria-label="Undo last action"
                >
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
