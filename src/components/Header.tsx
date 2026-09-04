'use client'

import { useState, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useTheme } from 'next-themes'
import { useSimpleLongPress } from '@/hooks/useLongPress'
import Image from 'next/image'
import Link from 'next/link'
import {
  ChevronLeft,
  Clock,
  Undo2,
  Redo2,
  Menu,
  Keyboard,
  Settings,
  Trash2,
  Bot,
  Sun,
  Moon,
  Monitor,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { BUILD_ID, VERSION, formatBuildDate } from '@/lib/build-info'
import { CountBadge } from '@/components/CountBadge'
import { SearchBar } from './SearchBar'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import {
  useSnoozePreferences,
  useAiAvailable,
  useAiFeatureInfo,
} from '@/components/PreferencesProvider'
import { formatCompactSnoozeLabel } from '@/lib/snooze'
import { AIStatusDot } from '@/components/AIStatusContent'
import { AIStatusModal } from '@/components/AIStatusModal'
import { GuardedLink } from '@/components/GuardedLink'

interface HeaderProps {
  backHref?: string
  title?: string
  headerAction?: React.ReactNode
  /**
   * Replaces the task-count pills. Surfaces that are not about tasks (Reminders)
   * put their own numbers here so they get the same top bar as the Tasks page —
   * logo, undo, menu — instead of a bare page title.
   */
  badges?: React.ReactNode
  taskCount?: number
  overdueCount?: number
  todayCount?: number
  isSelectionMode?: boolean
  onUndo: () => void
  onRedo: () => void
  undoCount?: number
  redoCount?: number
  onSearch?: (query: string) => void
  onSearchClear?: () => void
  onSnoozeOverdue?: (until?: string) => void
  onShowKeyboardShortcuts?: () => void
  timezone?: string
  searchFocusRef?: React.MutableRefObject<(() => void) | null>
}

export function Header({
  backHref,
  title,
  headerAction,
  badges,
  taskCount = 0,
  overdueCount = 0,
  todayCount = 0,
  isSelectionMode = false,
  onUndo,
  onRedo,
  undoCount = 0,
  redoCount = 0,
  onSearch,
  onSearchClear,
  onSnoozeOverdue,
  onShowKeyboardShortcuts,
  timezone,
  searchFocusRef,
}: HeaderProps) {
  const { data: session } = useSession()
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false)
  const [aiStatusOpen, setAiStatusOpen] = useState(false)
  const [aiSlotState, setAiSlotState] = useState<string | null>(null)
  const { defaultSnoozeOption } = useSnoozePreferences()
  const aiAvailable = useAiAvailable()
  const { aiFeatureInfo } = useAiFeatureInfo()

  // Only show the status dot when at least one feature uses SDK mode
  const hasSdkFeature = aiFeatureInfo
    ? Object.values(aiFeatureInfo).some((f) => f.mode === 'sdk')
    : false

  /** Fetch AI slot state lazily when the hamburger menu opens (SDK features only) */
  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!aiAvailable || !hasSdkFeature) return
      if (open && aiSlotState === null) {
        fetch('/api/ai/status')
          .then((res) => {
            if (res.status === 503) {
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
            if (!json?.data) return
            // Use worst slot state across SDK-mode features.
            // Skip 'uninitialized' — it means the warm slot is intentionally disabled
            // and the feature works via cold path (not an error condition).
            const states: string[] = []
            if (aiFeatureInfo?.enrichment?.mode === 'sdk' && json.data.enrichment_slot?.state) {
              if (json.data.enrichment_slot.state !== 'uninitialized')
                states.push(json.data.enrichment_slot.state)
            }
            if (aiFeatureInfo?.quick_take?.mode === 'sdk' && json.data.quick_take_slot?.state) {
              if (json.data.quick_take_slot.state !== 'uninitialized')
                states.push(json.data.quick_take_slot.state)
            }
            // Priority: dead > uninitialized > initializing > busy > available
            const worst =
              states.find((s) => s === 'dead') ??
              states.find((s) => s === 'uninitialized') ??
              states.find((s) => s === 'initializing') ??
              states.find((s) => s === 'busy') ??
              states[0] ??
              'unknown'
            setAiSlotState(worst)
          })
          .catch(() => setAiSlotState('unknown'))
      }
    },
    [aiSlotState, aiAvailable, hasSdkFeature, aiFeatureInfo],
  )

  const snoozePress = useSimpleLongPress({
    onLongPress: () => setSnoozeMenuOpen(true),
    onShortPress: () => onSnoozeOverdue?.(),
  })

  return (
    <TooltipProvider delayDuration={300}>
      <header className="safe-top bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm select-none">
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
                    'h-7 w-auto flex-shrink-0 cursor-pointer transition-opacity duration-200 md:h-9',
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

          {headerAction}

          {/* Middle section: badges + search. flex-1 keeps buttons fixed. */}
          <div className="flex min-w-0 flex-1 items-center">
            {/* Badge container: @container enables container queries on mobile.
                md:[container-type:normal] disables containment on desktop where
                md:inline-flex handles visibility via media queries instead. */}
            <div
              className={cn(
                '@container/badges min-w-0 flex-1 transition-[opacity,max-width] duration-200 md:[container-type:normal] md:flex-none md:flex-shrink-0',
                searchExpanded
                  ? 'pointer-events-none opacity-0 md:max-w-0 md:overflow-hidden'
                  : 'max-w-[12rem] opacity-100',
              )}
            >
              {badges ?? (
                <TaskCountBadges
                  taskCount={taskCount}
                  overdueCount={overdueCount}
                  todayCount={todayCount}
                />
              )}
            </div>

            {/* Search: ml-auto keeps it right-aligned, expands leftward */}
            {onSearch && onSearchClear && (
              <SearchBar
                onSearch={onSearch}
                onClear={onSearchClear}
                onExpandedChange={setSearchExpanded}
                focusRef={searchFocusRef}
              />
            )}
          </div>

          {/* Action buttons: always fixed in place */}
          <div className="flex flex-shrink-0 items-center">
            {/* Snooze all overdue button - desktop only (mobile uses FAB).
               Single click: snooze using default duration.
               Long-press (400ms): opens SnoozeMenu with duration choices. */}
            {onSnoozeOverdue && !isSelectionMode && (
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
                  aria-label={
                    overdueCount > 0
                      ? `Snooze ${overdueCount} overdue tasks (hold for options)`
                      : 'Snooze overdue tasks (hold for options)'
                  }
                  className="relative hidden md:inline-flex"
                >
                  <Clock className="size-5" />
                  {overdueCount > 0 && (
                    <span className="bg-badge-destructive text-destructive-foreground absolute top-0 right-0 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold">
                      {overdueCount > 999 ? '999+' : overdueCount}
                    </span>
                  )}
                  <span className="bg-muted text-muted-foreground absolute right-0 bottom-0 rounded px-0.5 text-[8px] leading-tight font-medium">
                    {formatCompactSnoozeLabel(defaultSnoozeOption)}
                  </span>
                </Button>
              </SnoozeMenu>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onUndo()}
                  aria-label={undoCount > 0 ? `Undo (${undoCount} available)` : 'Undo'}
                  className="relative"
                >
                  <Undo2 className="size-5" />
                  {undoCount > 0 && (
                    <span className="bg-badge-neutral absolute top-0 right-0 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold text-white dark:text-zinc-900">
                      {undoCount > 99 ? '99+' : undoCount}
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Undo</TooltipContent>
            </Tooltip>

            {/* Hamburger menu */}
            <DropdownMenu onOpenChange={handleMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Menu">
                  <Menu className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-w-48">
                {session?.user?.name && (
                  <>
                    <DropdownMenuLabel className="text-muted-foreground line-clamp-2 text-xs font-normal break-all">
                      Signed in as {session.user.name}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={onRedo}>
                  <Redo2 className="size-4" />
                  Redo
                  {redoCount > 0 && (
                    <span className="text-muted-foreground ml-1 text-xs">({redoCount})</span>
                  )}
                  <span className="text-muted-foreground ml-auto hidden text-xs md:inline">
                    ⌘⇧Z
                  </span>
                </DropdownMenuItem>
                {onShowKeyboardShortcuts && (
                  <DropdownMenuItem onClick={onShowKeyboardShortcuts} className="hidden md:flex">
                    <Keyboard className="size-4" />
                    Shortcuts
                    <span className="text-muted-foreground ml-auto text-xs">?</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {aiAvailable && (
                  <DropdownMenuItem onClick={() => setAiStatusOpen(true)}>
                    <Bot className="size-4" />
                    AI Status
                    {hasSdkFeature && aiSlotState && aiSlotState !== 'disabled' && (
                      <AIStatusDot state={aiSlotState} className="ml-auto" />
                    )}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {resolvedTheme === 'dark' ? (
                      <Moon className="size-4" />
                    ) : (
                      <Sun className="size-4" />
                    )}
                    Theme
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                      <DropdownMenuRadioItem value="light">
                        <Sun className="size-4" />
                        Light
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="dark">
                        <Moon className="size-4" />
                        Dark
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="system">
                        <Monitor className="size-4" />
                        System
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {/* Trash and Settings live here because the mobile tab bar has
                    five slots and spends them on daily destinations. This menu is
                    the only overflow surface on mobile, so it is also the only
                    route to Trash there — the desktop sidebar still lists both. */}
                <DropdownMenuItem asChild>
                  <GuardedLink href="/trash">
                    <Trash2 className="size-4" />
                    Trash
                  </GuardedLink>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <GuardedLink href="/settings">
                    <Settings className="size-4" />
                    Settings
                  </GuardedLink>
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

/**
 * The Tasks page's three pills: total, overdue (red, only when > 0), due today
 * (blue). Tap opens a popover that spells each one out; the tooltips step
 * aside while it is open so the two never stack.
 */
function TaskCountBadges({
  taskCount,
  overdueCount,
  todayCount,
}: {
  taskCount: number
  overdueCount: number
  todayCount: number
}) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <div
          className="flex flex-shrink-0 cursor-pointer items-center gap-1"
          role="group"
          aria-label="Task counts"
          tabIndex={0}
        >
          <CountBadge
            count={taskCount}
            tooltip={
              popoverOpen ? undefined : `${taskCount} total task${taskCount === 1 ? '' : 's'}`
            }
            className={cn(
              'hidden items-center justify-center select-none md:inline-flex',
              overdueCount > 0 ? '@[4.75rem]/badges:inline-flex' : '@[2.75rem]/badges:inline-flex',
            )}
          />
          {overdueCount > 0 && (
            <CountBadge
              count={overdueCount}
              variant="overdue"
              tooltip={popoverOpen ? undefined : `${overdueCount} overdue`}
              className="hidden items-center justify-center select-none md:inline-flex @[2.75rem]/badges:inline-flex"
            />
          )}
          <CountBadge
            count={todayCount}
            variant="today"
            tooltip={popoverOpen ? undefined : `${todayCount} due today`}
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
          {overdueCount > 0 && <span className="text-destructive">{overdueCount} overdue</span>}
          {todayCount > 0 && <span className="text-primary">{todayCount} due today</span>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
