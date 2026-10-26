'use client'

import { OVERDUE_LOWER } from '@/lib/task-model-words'
import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useTheme } from 'next-themes'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import {
  Undo2,
  Redo2,
  Menu,
  Keyboard,
  Archive,
  Settings,
  Trash2,
  Bot,
  Sun,
  Moon,
  Monitor,
  BookOpen,
  Plus,
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
import { SnoozeOverdueTrigger } from '@/components/SnoozeOverdueTrigger'
import { useAiAvailable } from '@/components/PreferencesProvider'
import { useAiSlotState } from '@/hooks/useAiSlotState'
import { AIStatusDot } from '@/components/AIStatusContent'
import { AIStatusModal } from '@/components/AIStatusModal'
import { ProcessMenuItem } from '@/components/process/ProcessMenuItem'
import { ProcessModal } from '@/components/process/ProcessModal'
import { GuardedLink } from '@/components/GuardedLink'
import { DOCS_URL } from '@/lib/docs-url'
import { useNavigationGuard } from '@/components/NavigationGuardProvider'
import { OPEN_PROCESS_EVENT, PROCESS_ACTION } from '@/lib/process-client'
import { OPEN_ADD_EVENT, addActionLabel } from '@/lib/add-action'

interface HeaderProps {
  title?: string
  headerAction?: React.ReactNode
  /**
   * Replaces the task-count pills. Surfaces that are not about tasks (Reminders)
   * put their own numbers here so they get the same top bar as the Tasks page —
   * logo, undo, menu — instead of a bare page title.
   */
  badges?: React.ReactNode
  /**
   * Where you are, set beside the logo (“OpenTask | Reminders”). The Tasks
   * page is home and goes without; a peer surface names itself here so the
   * bar reads as the same app in a different mode rather than a bare title.
   */
  section?: string
  taskCount?: number
  overdueCount?: number
  todayCount?: number
  /**
   * Tap on the red overdue / today pill (see `TaskCountBadges`). The dashboard
   * passes its exclusive date-filter setter; without it the pills link to the
   * dashboard's `?filter=` deep link.
   */
  onPillFilter?: (filter: HeaderPillFilter) => void
  /** Which pill's filter is the sole active date filter, for `aria-pressed`. */
  activePillFilter?: HeaderPillFilter | null
  onUndo: () => void
  onRedo: () => void
  undoCount?: number
  redoCount?: number
  onSearch?: (query: string) => void
  onSearchClear?: () => void
  onSnoozeOverdue?: (until?: string) => void
  /** The clock with a selection: defers the selected tasks instead. */
  onSnoozeSelected?: (until?: string) => void
  /** Selected task rows; above 0, the clock acts on (and counts) them. */
  snoozeSelectedCount?: number
  /**
   * The snooze-all clock's badge: overdue tasks a press would sweep. Not
   * `overdueCount`, which is the red pill's date-facet number — see
   * `SnoozeOverdueTrigger`.
   */
  snoozeOverdueCount?: number
  /** Whether the user has periods, for the clock's "Next" badge. */
  hasPeriods?: boolean
  onShowKeyboardShortcuts?: () => void
  timezone?: string
  searchFocusRef?: React.MutableRefObject<(() => void) | null>
  /** What the search bar searches, for its placeholder. Default: tasks. */
  searchSubject?: string
  /**
   * Widen the bar at `xl` to match the two-column Tasks page beneath it.
   *
   * The bar is normally `mx-auto max-w-2xl px-4`, which lines its contents up
   * exactly with a `mx-auto max-w-2xl px-4` page column below it. At `xl` the
   * Tasks page grows to two equal columns inside a wider, more generously
   * padded box (`xl:max-w-[86.5rem] xl:px-10` — see `mainClass` in
   * `DashboardClient`), and a bar that kept the narrow box would leave the logo
   * hard against the sidebar with the column it belongs to starting 24px
   * further in. The two values are deliberately duplicated rather than shared
   * through a constant: Tailwind only emits classes it can see as literal text,
   * so a computed string would generate no CSS at all. `dashboard-layout.spec.ts`
   * measures that the two edges still agree.
   *
   * Opt-in, because the other surfaces that use this bar (Reminders, Quotas)
   * stay one centred `max-w-2xl` column at every width.
   */
  wideAtXl?: boolean
}

export function Header({
  title,
  headerAction,
  badges,
  section,
  taskCount = 0,
  overdueCount = 0,
  todayCount = 0,
  onPillFilter,
  activePillFilter = null,
  onUndo,
  onRedo,
  undoCount = 0,
  redoCount = 0,
  onSearch,
  onSearchClear,
  onSnoozeOverdue,
  onSnoozeSelected,
  snoozeSelectedCount = 0,
  snoozeOverdueCount = 0,
  hasPeriods = false,
  onShowKeyboardShortcuts,
  timezone,
  searchFocusRef,
  searchSubject,
  wideAtXl = false,
}: HeaderProps) {
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [aiStatusOpen, setAiStatusOpen] = useState(false)
  const [processOpen, setProcessOpen] = useState(false)
  // Bumped on each opening: the modal remounts, so every Process starts fresh.
  const [processSession, setProcessSession] = useState(0)
  // Process asked for from outside this menu: a task segment's "over 50"
  // nudge (`SegmentNudge` in TaskSegmentRow) and the left bar's Process row.
  // Cancelling the event tells the left bar it opened here; on a page with no
  // top bar it goes to `/?action=process` instead, opened below on arrival
  // (src/lib/process-client.ts). Only with a `timezone`, without which there
  // is no modal to open.
  useEffect(() => {
    if (!timezone) return
    const openProcess = () => {
      setProcessSession((n) => n + 1)
      setProcessOpen(true)
    }
    const onRequest = (e: Event) => {
      e.preventDefault()
      openProcess()
    }
    window.addEventListener(OPEN_PROCESS_EVENT, onRequest)
    const params = new URLSearchParams(window.location.search)
    if (params.get('action') === PROCESS_ACTION) {
      // Raw history rewrite, like the dashboard's `?action=quick-add`.
      window.history.replaceState(window.history.state, '', window.location.pathname)
      openProcess()
    }
    return () => window.removeEventListener(OPEN_PROCESS_EVENT, onRequest)
  }, [timezone])

  return (
    <TooltipProvider delayDuration={300}>
      <header className="safe-top bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm select-none">
        <div
          className={cn(
            'relative mx-auto flex max-w-2xl items-center gap-1.5 px-4 py-3 md:gap-2',
            // The same box the page's own `<main>` gets — see `wideAtXl`.
            wideAtXl && 'xl:max-w-[86.5rem] xl:px-10',
          )}
        >
          {/* Logo or title with build info popover */}
          {title ? (
            <h1
              className={cn(
                'min-w-0 truncate text-lg font-semibold transition-opacity duration-200',
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
                    'w-auto flex-shrink-0 cursor-pointer transition-opacity duration-200 md:h-9',
                    // With a section label beside it the bar is tight on a phone
                    // (logo + label + pill + two buttons in 375px), so the logo
                    // drops a step there. In px, not rem: the iOS app scales the
                    // root font with Dynamic Type (WebView.swift), and a logo
                    // that grew with the text at Trent's 119% was what pushed
                    // the bar past a 402px phone (2026-10-26). It is a picture,
                    // not text; the words beside it still scale.
                    section ? 'h-[24px]' : 'h-[28px]',
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

          {section && !title && (
            <>
              <span
                aria-hidden="true"
                className="bg-border mx-0.5 h-5 w-px flex-shrink-0 md:mx-1"
              />
              {/* THE BAR NEVER OVERFLOWS (2026-10-26). At a large text size
                  the logo, this label, search, undo and menu are wider than
                  a phone. Every other piece is a fixed control, so the label
                  is the one that gives way (an ellipsis) — before, nothing
                  could: the search button slid back over the label and the
                  menu button ran off the right edge, which widened the page
                  and let iOS zoom the whole app out. */}
              <span
                data-header-section
                className="text-foreground min-w-0 truncate text-sm font-semibold tracking-tight md:text-base"
              >
                {section}
              </span>
            </>
          )}

          {headerAction}

          {/* Middle section: badges + search. flex-1 keeps buttons fixed.
              `min-w-fit` on a phone: never narrower than the search button
              (the badges are a size container, so they ask for nothing), or
              the button overflows onto the label beside it. */}
          <div className="flex min-w-fit flex-1 items-center md:min-w-0">
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
                  onPillFilter={onPillFilter}
                  activePillFilter={activePillFilter}
                />
              )}
            </div>

            {/* Search: ml-auto keeps it right-aligned, expands leftward */}
            {onSearch && onSearchClear && (
              <SearchBar
                onSearch={onSearch}
                onClear={onSearchClear}
                subject={searchSubject}
                onExpandedChange={setSearchExpanded}
                focusRef={searchFocusRef}
              />
            )}
          </div>

          {/* Action buttons: always fixed in place */}
          <div className="flex flex-shrink-0 items-center">
            {/* Snooze all overdue — desktop only (`md` and up). The FAB, shown at
               every width, is the same control (`SnoozeOverdueTrigger`); the
               top-bar copy stays too (Trent, 2026-09-29). With a selection it
               stays and defers the selection (2026-10-26). */}
            {onSnoozeOverdue && (
              <SnoozeOverdueTrigger
                variant="header"
                overdueCount={snoozeOverdueCount}
                selectedCount={snoozeSelectedCount}
                hasPeriods={hasPeriods}
                onSnoozeOverdue={onSnoozeOverdue}
                onSnoozeSelected={onSnoozeSelected}
              />
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
            <HeaderMenu
              onRedo={onRedo}
              redoCount={redoCount}
              onShowKeyboardShortcuts={onShowKeyboardShortcuts}
              timezone={timezone}
              onOpenProcess={() => {
                setProcessSession((n) => n + 1)
                setProcessOpen(true)
              }}
              onOpenAiStatus={() => setAiStatusOpen(true)}
            />
          </div>
        </div>
      </header>

      {timezone && (
        <AIStatusModal open={aiStatusOpen} onOpenChange={setAiStatusOpen} timezone={timezone} />
      )}
      {timezone && (
        <ProcessModal
          key={processSession}
          open={processOpen}
          onOpenChange={setProcessOpen}
          timezone={timezone}
        />
      )}
    </TooltipProvider>
  )
}

/**
 * The top bar's ☰ menu. Order (2026-10-14, mockup P1): Add Task (phone only),
 * divider, Process, divider, the destinations (Archive, Trash, Settings,
 * Docs), divider, then the tools (Redo, Shortcuts, AI Status, Theme).
 */
function HeaderMenu({
  onRedo,
  redoCount,
  onShowKeyboardShortcuts,
  timezone,
  onOpenProcess,
  onOpenAiStatus,
}: {
  onRedo: () => void
  redoCount: number
  onShowKeyboardShortcuts?: () => void
  timezone?: string
  onOpenProcess: () => void
  onOpenAiStatus: () => void
}) {
  const { data: session } = useSession()
  const pathname = usePathname()
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [menuOpened, setMenuOpened] = useState(false)
  const aiAvailable = useAiAvailable()
  // The AI Status item's dot: fetched the first time the menu opens, then kept.
  const aiSlotState = useAiSlotState({ enabled: menuOpened })

  return (
    <DropdownMenu onOpenChange={(open) => open && setMenuOpened(true)}>
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
        {/* Order (2026-10-14, mockup P1): Add Task, divider, Process,
            divider, then the destinations; the tools (Redo, Shortcuts,
            AI Status, Theme) follow below one more divider. Add Task is
            phone-only: from `md` up the left bar's button sits right
            there. It runs the left bar's handler (`OPEN_ADD_EVENT`). */}
        <DropdownMenuItem
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ADD_EVENT))}
          className="md:hidden"
          data-menu-add
        >
          <Plus className="size-4" />
          {addActionLabel(pathname)}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="md:hidden" />
        {timezone && (
          <>
            <ProcessMenuItem onSelect={onOpenProcess} />
            <DropdownMenuSeparator />
          </>
        )}
        {/* Archive, Trash and Settings live here because the mobile tab
            bar has five slots and spends them on daily destinations.
            This menu is the only overflow surface on mobile, so it is
            also the only route to these there — the desktop sidebar
            still lists all three. Archive moved here on 2026-09-06 when
            Quotas took its tab. */}
        <DropdownMenuItem asChild>
          <GuardedLink href="/archive">
            <Archive className="size-4" />
            Archive
          </GuardedLink>
        </DropdownMenuItem>
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
        <DropdownMenuItem asChild>
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
            <BookOpen className="size-4" />
            Docs
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onRedo}>
          <Redo2 className="size-4" />
          Redo
          {redoCount > 0 && (
            <span className="text-muted-foreground ml-1 text-xs">({redoCount})</span>
          )}
          <span className="text-muted-foreground ml-auto hidden text-xs md:inline">⌘⇧Z</span>
        </DropdownMenuItem>
        {onShowKeyboardShortcuts && (
          <DropdownMenuItem onClick={onShowKeyboardShortcuts} className="hidden md:flex">
            <Keyboard className="size-4" />
            Shortcuts
            <span className="text-muted-foreground ml-auto text-xs">?</span>
          </DropdownMenuItem>
        )}
        {aiAvailable && (
          <DropdownMenuItem onClick={onOpenAiStatus}>
            <Bot className="size-4" />
            AI Status
            {aiSlotState && aiSlotState !== 'disabled' && (
              <AIStatusDot state={aiSlotState} className="ml-auto" />
            )}
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {resolvedTheme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The two date filters the top bar's pills can apply. */
export type HeaderPillFilter = 'overdue' | 'today'

/**
 * The Tasks page's three pills: total, overdue (red, only when > 0), due today.
 *
 * - **Total** is read-only: tapping it opens a popover that spells all three
 *   numbers out (the only way to read them on a touch screen, where the
 *   tooltips never show). Its tooltip steps aside while the popover is open.
 * - **Overdue** and **due today** are buttons (Trent, 2026-09-26): a tap
 *   applies that date filter EXCLUSIVELY on the dashboard — the same
 *   `exclusiveDateFilter` the expanded Overdue/Today chips' Cmd+click uses, so
 *   a second tap while it is the only date filter clears it again. They count
 *   the same faceted set as those chips (see `headerCounts` in
 *   DashboardClient's `DashboardView`), so the number on the pill is the
 *   number the filtered list shows. Without an `onPillFilter` (a surface that
 *   is not the dashboard) they navigate to the dashboard's `?filter=overdue` /
 *   `?filter=today` deep link instead — today no such surface renders these
 *   pills, but a pill that looks tappable must never be dead.
 *
 * Each pill is its own control, so the old single popover trigger wrapping all
 * three is gone — a button inside a focusable trigger would be nested
 * interactive content. The container-query classes (`@[..]/badges:`) are
 * untouched: on a narrow phone bar the total, then the overdue pill, still
 * drop out as the `@container/badges` box in `Header` shrinks.
 */
function TaskCountBadges({
  taskCount,
  overdueCount,
  todayCount,
  onPillFilter,
  activePillFilter,
}: {
  taskCount: number
  overdueCount: number
  todayCount: number
  onPillFilter?: (filter: HeaderPillFilter) => void
  activePillFilter?: HeaderPillFilter | null
}) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const router = useRouter()
  const { requestNavigation } = useNavigationGuard()
  const applyFilter = (filter: HeaderPillFilter) => {
    if (onPillFilter) {
      onPillFilter(filter)
      return
    }
    const href = `/?filter=${filter}`
    if (requestNavigation(href)) router.push(href)
  }
  const overdueActive = activePillFilter === 'overdue'
  const todayActive = activePillFilter === 'today'
  return (
    <div className="flex flex-shrink-0 items-center gap-1" role="group" aria-label="Task counts">
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${taskCount} total task${taskCount === 1 ? '' : 's'} — show breakdown`}
            className={cn(
              'hidden cursor-pointer items-center justify-center select-none md:inline-flex',
              overdueCount > 0 ? '@[4.75rem]/badges:inline-flex' : '@[2.75rem]/badges:inline-flex',
            )}
          >
            <CountBadge
              count={taskCount}
              tooltip={
                popoverOpen ? undefined : `${taskCount} total task${taskCount === 1 ? '' : 's'}`
              }
            />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto px-3 py-2 text-xs" sideOffset={6}>
          <div className="flex flex-col gap-1">
            <span>{taskCount} total tasks</span>
            {overdueCount > 0 && (
              <span className="text-over-target">
                {overdueCount} {OVERDUE_LOWER}
              </span>
            )}
            {todayCount > 0 && <span className="text-primary">{todayCount} today</span>}
          </div>
        </PopoverContent>
      </Popover>
      {overdueCount > 0 && (
        <CountBadge
          count={overdueCount}
          variant="overdue"
          tooltip={
            overdueActive ? 'Show all tasks' : `${overdueCount} ${OVERDUE_LOWER} — show only these`
          }
          onClick={() => applyFilter('overdue')}
          ariaLabel={
            overdueActive
              ? `${overdueCount} ${OVERDUE_LOWER} — clear the ${OVERDUE_LOWER} filter`
              : `${overdueCount} ${OVERDUE_LOWER} — show only ${OVERDUE_LOWER} tasks`
          }
          pressed={overdueActive}
          className="hidden items-center justify-center select-none md:inline-flex @[2.75rem]/badges:inline-flex"
        />
      )}
      <CountBadge
        count={todayCount}
        variant="today"
        tooltip={todayActive ? 'Show all tasks' : `${todayCount} for today — show only these`}
        onClick={() => applyFilter('today')}
        ariaLabel={
          todayActive
            ? `${todayCount} for today — clear the today filter`
            : `${todayCount} for today — show only today's tasks`
        }
        pressed={todayActive}
        className={cn(
          'inline-flex items-center justify-center select-none',
          todayCount === 0 && 'md:hidden',
        )}
      />
    </div>
  )
}
