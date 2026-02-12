'use client'

import { useState, useCallback } from 'react'
import { useSimpleLongPress } from '@/hooks/useLongPress'
import Image from 'next/image'
import Link from 'next/link'
import { ChevronLeft, Clock, Undo2, Redo2, Menu, Keyboard, Settings, Bot } from 'lucide-react'
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
import { CountBadge } from '@/components/CountBadge'
import { SearchBar } from './SearchBar'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { useSnoozePreferences } from '@/components/PreferencesProvider'
import { formatCompactSnoozeLabel } from '@/lib/snooze'
import { AIStatusDot } from '@/components/AIStatusContent'
import { AIStatusModal } from '@/components/AIStatusModal'

interface HeaderProps {
  backHref?: string
  title?: string
  taskCount: number
  overdueCount?: number
  todayCount?: number
  isSelectionMode?: boolean
  onUndo: () => void
  onRedo: () => void
  undoCount?: number
  redoCount?: number
  onBatchUndo?: () => void
  onBatchRedo?: () => void
  onSearch?: (query: string) => void
  onSearchClear?: () => void
  onSnoozeOverdue?: (until?: string) => void
  onShowKeyboardShortcuts?: () => void
  timezone?: string
}

export function Header({
  backHref,
  title,
  taskCount,
  overdueCount = 0,
  todayCount = 0,
  isSelectionMode = false,
  onUndo,
  onRedo,
  undoCount = 0,
  redoCount = 0,
  onBatchUndo,
  onBatchRedo,
  onSearch,
  onSearchClear,
  onSnoozeOverdue,
  onShowKeyboardShortcuts,
  timezone,
}: HeaderProps) {
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [badgePopoverOpen, setBadgePopoverOpen] = useState(false)
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false)
  const [aiStatusOpen, setAiStatusOpen] = useState(false)
  const [aiSlotState, setAiSlotState] = useState<string | null>(null)
  const { defaultSnoozeOption } = useSnoozePreferences()

  /** Fetch AI slot state lazily when the hamburger menu opens */
  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open && aiSlotState === null) {
        fetch('/api/ai/status')
          .then((res) => {
            if (res.status === 503) {
              // AI not enabled — no dot
              setAiSlotState('disabled')
              return null
            }
            if (!res.ok) {
              setAiSlotState('unknown')
              return null
            }
            return res.json()
          })
          .then((json) => {
            if (json?.data?.enrichment_slot?.state) {
              setAiSlotState(json.data.enrichment_slot.state)
            }
          })
          .catch(() => setAiSlotState('unknown'))
      }
    },
    [aiSlotState],
  )

  const snoozePress = useSimpleLongPress({
    onLongPress: () => setSnoozeMenuOpen(true),
    onShortPress: () => onSnoozeOverdue?.(),
  })

  const undoPress = useSimpleLongPress({
    onLongPress: () => onBatchUndo?.(),
    onShortPress: () => onUndo(),
  })

  const redoPress = useSimpleLongPress({
    onLongPress: () => onBatchRedo?.(),
    onShortPress: () => onRedo(),
  })

  return (
    <TooltipProvider delayDuration={300}>
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm select-none">
        <div className="relative mx-auto flex max-w-2xl items-center gap-1.5 px-4 py-3 md:gap-2">
          {/* Back button (when navigating into a sub-page like project detail) */}
          {backHref && (
            <Link href={backHref}>
              <Button variant="ghost" size="icon" aria-label="Back" className="-ml-2 flex-shrink-0">
                <ChevronLeft className="size-5" />
              </Button>
            </Link>
          )}

          {/* Logo or title with build info popover */}
          {title ? (
            <h1
              className={cn(
                'flex-shrink-0 truncate text-lg font-semibold transition-opacity duration-200',
                searchExpanded ? 'opacity-0 md:opacity-100' : '',
              )}
            >
              {title}
            </h1>
          ) : (
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
          )}

          {/* Middle section: badges + search. flex-1 keeps buttons fixed. */}
          <div className="flex min-w-0 flex-1 items-center">
            {/* Badge container: @container enables container queries on mobile.
                md:[container-type:normal] disables containment on desktop where
                md:inline-flex handles visibility via media queries instead. */}
            <div className="@container/badges min-w-0 flex-1 md:[container-type:normal] md:flex-none md:flex-shrink-0">
              <Popover open={badgePopoverOpen} onOpenChange={setBadgePopoverOpen}>
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
                    <CountBadge
                      count={taskCount}
                      tooltip={
                        badgePopoverOpen
                          ? undefined
                          : `${taskCount} total task${taskCount === 1 ? '' : 's'}`
                      }
                      className={cn(
                        'hidden items-center justify-center select-none md:inline-flex',
                        overdueCount > 0
                          ? '@[4.75rem]/badges:inline-flex'
                          : '@[2.75rem]/badges:inline-flex',
                      )}
                    />
                    {overdueCount > 0 && (
                      <CountBadge
                        count={overdueCount}
                        variant="overdue"
                        tooltip={badgePopoverOpen ? undefined : `${overdueCount} overdue`}
                        className="hidden items-center justify-center select-none md:inline-flex @[2.75rem]/badges:inline-flex"
                      />
                    )}
                    <CountBadge
                      count={todayCount}
                      variant="today"
                      tooltip={badgePopoverOpen ? undefined : `${todayCount} due today`}
                      className={cn(
                        'inline-flex items-center justify-center select-none',
                        todayCount === 0 && 'md:hidden',
                      )}
                    />
                  </div>
                </PopoverTrigger>
                <PopoverContent className="w-auto px-3 py-2 text-xs" sideOffset={6}>
                  <div className="flex flex-col gap-1">
                    <span>{taskCount} total tasks</span>
                    {overdueCount > 0 && (
                      <span className="text-destructive">{overdueCount} overdue</span>
                    )}
                    {todayCount > 0 && <span className="text-primary">{todayCount} due today</span>}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

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
            {onSnoozeOverdue && overdueCount > 0 && !isSelectionMode && (
              <SnoozeMenu
                open={snoozeMenuOpen}
                onOpenChange={setSnoozeMenuOpen}
                onSnooze={(until) => onSnoozeOverdue(until)}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={snoozePress.onClick}
                  onPointerDown={snoozePress.onPointerDown}
                  onPointerUp={snoozePress.onPointerUp}
                  onPointerLeave={snoozePress.onPointerLeave}
                  aria-label={`Snooze ${overdueCount} overdue tasks (hold for options)`}
                  className="relative hidden md:inline-flex"
                >
                  <Clock className="size-5" />
                  <span className="bg-destructive text-destructive-foreground absolute top-0 right-0 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold">
                    {overdueCount > 999 ? '999+' : overdueCount}
                  </span>
                  <span className="bg-muted text-muted-foreground absolute right-0 bottom-0 rounded px-0.5 text-[8px] leading-tight font-medium">
                    {formatCompactSnoozeLabel(defaultSnoozeOption)}
                  </span>
                </Button>
              </SnoozeMenu>
            )}

            {/* Mobile-only undo/redo buttons with count badges.
                Single tap: undo/redo one action.
                Long-press (400ms): triggers batch undo/redo. */}
            <div className="flex md:hidden">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={undoPress.onClick}
                    onPointerDown={undoPress.onPointerDown}
                    onPointerUp={undoPress.onPointerUp}
                    onPointerLeave={undoPress.onPointerLeave}
                    aria-label={
                      undoCount > 0 ? `Undo (${undoCount} available, hold for all)` : 'Undo'
                    }
                    className="relative"
                  >
                    <Undo2 className="size-5" />
                    {undoCount > 0 && (
                      <span className="bg-muted-foreground/80 absolute top-0.5 right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] leading-none font-bold text-white">
                        {undoCount > 99 ? '99+' : undoCount}
                      </span>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Undo (hold for all)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={redoPress.onClick}
                    onPointerDown={redoPress.onPointerDown}
                    onPointerUp={redoPress.onPointerUp}
                    onPointerLeave={redoPress.onPointerLeave}
                    aria-label={
                      redoCount > 0 ? `Redo (${redoCount} available, hold for all)` : 'Redo'
                    }
                    className="relative"
                  >
                    <Redo2 className="size-5" />
                    {redoCount > 0 && (
                      <span className="bg-muted-foreground/80 absolute top-0.5 right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] leading-none font-bold text-white">
                        {redoCount > 99 ? '99+' : redoCount}
                      </span>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Redo (hold for all)</TooltipContent>
              </Tooltip>
            </div>

            {/* Hamburger menu */}
            <DropdownMenu onOpenChange={handleMenuOpenChange}>
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
                  {undoCount > 0 && (
                    <span className="text-muted-foreground ml-1 text-xs">({undoCount})</span>
                  )}
                  <span className="text-muted-foreground ml-auto text-xs">⌘Z</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onRedo} className="hidden md:flex">
                  <Redo2 className="size-4" />
                  Redo
                  {redoCount > 0 && (
                    <span className="text-muted-foreground ml-1 text-xs">({redoCount})</span>
                  )}
                  <span className="text-muted-foreground ml-auto text-xs">⌘⇧Z</span>
                </DropdownMenuItem>
                {onBatchUndo && undoCount > 1 && (
                  <DropdownMenuItem onClick={onBatchUndo} className="hidden md:flex">
                    <Undo2 className="size-4" />
                    Undo Session...
                    <span className="text-muted-foreground ml-1 text-xs">({undoCount})</span>
                  </DropdownMenuItem>
                )}
                {onBatchRedo && redoCount > 1 && (
                  <DropdownMenuItem onClick={onBatchRedo} className="hidden md:flex">
                    <Redo2 className="size-4" />
                    Redo All...
                    <span className="text-muted-foreground ml-1 text-xs">({redoCount})</span>
                  </DropdownMenuItem>
                )}
                {onShowKeyboardShortcuts && (
                  <DropdownMenuItem onClick={onShowKeyboardShortcuts} className="hidden md:flex">
                    <Keyboard className="size-4" />
                    Shortcuts
                    <span className="text-muted-foreground ml-auto text-xs">?</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setAiStatusOpen(true)}>
                  <Bot className="size-4" />
                  AI Status
                  {aiSlotState && aiSlotState !== 'disabled' && <AIStatusDot state={aiSlotState} />}
                </DropdownMenuItem>
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

      {timezone && (
        <AIStatusModal open={aiStatusOpen} onOpenChange={setAiStatusOpen} timezone={timezone} />
      )}
    </TooltipProvider>
  )
}
