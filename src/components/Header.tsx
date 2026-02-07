'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Clock, Undo2, Redo2, Menu, Keyboard, Settings } from 'lucide-react'
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
import { SearchBar } from './SearchBar'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { useSnoozePreferences } from '@/components/LabelConfigProvider'
import { formatCompactSnoozeLabel } from '@/lib/snooze'

interface HeaderProps {
  taskCount: number
  overdueCount?: number
  todayCount?: number
  snoozableOverdueCount?: number
  onUndo: () => void
  onRedo: () => void
  onSearch?: (query: string) => void
  onSearchClear?: () => void
  onSnoozeOverdue?: (until?: string) => void
  onShowKeyboardShortcuts?: () => void
}

export function Header({
  taskCount,
  overdueCount = 0,
  todayCount = 0,
  snoozableOverdueCount = 0,
  onUndo,
  onRedo,
  onSearch,
  onSearchClear,
  onSnoozeOverdue,
  onShowKeyboardShortcuts,
}: HeaderProps) {
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false)
  const snoozeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snoozeFiredRef = useRef(false)
  const { defaultSnoozeOption } = useSnoozePreferences()

  useEffect(() => {
    return () => {
      if (snoozeTimerRef.current) clearTimeout(snoozeTimerRef.current)
    }
  }, [])

  const handleSnoozePointerDown = useCallback(() => {
    snoozeFiredRef.current = false
    snoozeTimerRef.current = setTimeout(() => {
      snoozeFiredRef.current = true
      setSnoozeMenuOpen(true)
    }, 400)
  }, [])

  const handleSnoozePointerUp = useCallback(() => {
    if (snoozeTimerRef.current) {
      clearTimeout(snoozeTimerRef.current)
      snoozeTimerRef.current = null
    }
    if (!snoozeFiredRef.current) {
      snoozeFiredRef.current = true
      onSnoozeOverdue?.()
    }
  }, [onSnoozeOverdue])

  const handleSnoozeClick = useCallback(() => {
    if (snoozeFiredRef.current) {
      snoozeFiredRef.current = false
      return
    }
    onSnoozeOverdue?.()
  }, [onSnoozeOverdue])

  return (
    <TooltipProvider delayDuration={300}>
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm select-none">
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
                  <span className="bg-muted text-muted-foreground hidden min-w-[1.25rem] items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-medium select-none md:inline-flex">
                    {taskCount}
                  </span>
                  {overdueCount > 0 && (
                    <span className="bg-destructive/15 text-destructive hidden min-w-[1.25rem] items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-medium select-none md:inline-flex">
                      {overdueCount}
                    </span>
                  )}
                  <span
                    className={cn(
                      'bg-primary/15 text-primary inline-flex min-w-[1.25rem] items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-medium select-none',
                      todayCount === 0 && 'md:hidden',
                    )}
                  >
                    {todayCount}
                  </span>
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
            {/* Snooze all overdue button - desktop only (mobile uses FAB).
               Single click: snooze using default duration.
               Long-press (400ms): opens SnoozeMenu with duration choices. */}
            {onSnoozeOverdue && snoozableOverdueCount > 0 && (
              <SnoozeMenu
                open={snoozeMenuOpen}
                onOpenChange={setSnoozeMenuOpen}
                onSnooze={(until) => onSnoozeOverdue(until)}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleSnoozeClick}
                  onPointerDown={handleSnoozePointerDown}
                  onPointerUp={handleSnoozePointerUp}
                  onPointerLeave={() => {
                    if (snoozeTimerRef.current) {
                      clearTimeout(snoozeTimerRef.current)
                      snoozeTimerRef.current = null
                    }
                  }}
                  aria-label={`Snooze ${snoozableOverdueCount} overdue tasks (hold for options)`}
                  className="relative hidden md:inline-flex"
                >
                  <Clock className="size-5" />
                  <span className="bg-destructive text-destructive-foreground absolute top-0 right-0 flex size-4 items-center justify-center rounded-full text-[10px] leading-none font-bold">
                    {snoozableOverdueCount > 99 ? '99+' : snoozableOverdueCount}
                  </span>
                  <span className="bg-muted text-muted-foreground absolute right-0 bottom-0 rounded px-0.5 text-[8px] leading-tight font-medium">
                    {formatCompactSnoozeLabel(defaultSnoozeOption)}
                  </span>
                </Button>
              </SnoozeMenu>
            )}

            {/* Mobile-only undo/redo buttons */}
            <div className="flex md:hidden">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={onUndo} aria-label="Undo">
                    <Undo2 className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Undo</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={onRedo} aria-label="Redo">
                    <Redo2 className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Redo</TooltipContent>
              </Tooltip>
            </div>

            {/* Hamburger menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Menu">
                  <Menu className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Desktop-only: undo/redo in menu (mobile has header buttons) */}
                <DropdownMenuItem onClick={onUndo} className="hidden md:flex">
                  <Undo2 className="size-4" />
                  Undo
                  <span className="text-muted-foreground ml-auto text-xs">⌘Z</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onRedo} className="hidden md:flex">
                  <Redo2 className="size-4" />
                  Redo
                  <span className="text-muted-foreground ml-auto text-xs">⌘⇧Z</span>
                </DropdownMenuItem>
                {onShowKeyboardShortcuts && (
                  <DropdownMenuItem onClick={onShowKeyboardShortcuts} className="hidden md:flex">
                    <Keyboard className="size-4" />
                    Shortcuts
                    <span className="text-muted-foreground ml-auto text-xs">?</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <Settings className="size-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
    </TooltipProvider>
  )
}
