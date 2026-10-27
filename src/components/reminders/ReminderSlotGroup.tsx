'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CheckCheck, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatClockTime } from '@/lib/time-utils'
import { slotLabel } from '@/lib/reminder-slots'
import { groupConsidered, groupWaiting, promptWaiting, type QuotaPrompt } from '@/lib/quota-prompts'
import { scrollSectionIntoView } from '@/lib/scroll-row-into-view'
import { useLongPress } from '@/hooks/useLongPress'
import type { ReminderGroup } from '@/hooks/useReminders'
import { ConsideredPromptRow } from '@/components/QuotaPromptRow'
import { ReminderRow, type ReminderRowHandlers } from '@/components/reminders/ReminderRow'
import type { Task } from '@/types'

/** A section's header sweep: a slot's "Considered all", a task segment's "Defer all". */
export const SLOT_SWEEP_CLASS =
  'text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors'

/** The toggle under a section's rows ("Show all N", "Show N considered"). */
export const SLOT_FOOTER_TOGGLE_CLASS =
  'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground w-full rounded-lg py-2 pl-11 text-left text-xs font-medium transition-colors'

/** How many rows a not-yet-started slot shows before "Show all" (§7.3). */
export const SLOT_PREVIEW_COUNT = 5

/**
 * Whether a slot shows every row or just the first few.
 *
 * A slot whose time has come shows ALL of it. Trent's rule, 2026-09-06:
 * "everything expanded up to that point in the day if there are items that are
 * not finished… it's annoying to have to tap things to see what's undone from
 * early morning into the morning." A cap on a slot he has already reached is
 * exactly that tap, so the part of the day behind him is never abbreviated.
 *
 * Slots still ahead keep the cap: they are a preview of what is coming, not
 * work in hand, and uncapping them would bury today under tonight.
 */
export function slotShowsEverything(started: boolean, expanded: boolean): boolean {
  return started || expanded
}

/**
 * Which slots are open.
 *
 * Every slot starts open, including the ones whose time has not come — Trent,
 * 2026-09-06: "we can actually have all of them start expanded… the grayed-out
 * darker color lets you know that's not quite time for that yet but you can
 * still mark the items off." Before this only the current slot opened, so
 * anything left unfinished in the morning was invisible by lunchtime unless
 * you went looking for it, which is the opposite of what this surface is for.
 *
 * A slot the user closes stays closed for the session; the override map is
 * what remembers that, and it is deliberately not persisted.
 */
export function useSlotDisclosure() {
  const [openOverrides, setOpenOverrides] = useState<Map<string, boolean>>(new Map())
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const isOpen = useCallback((key: string) => openOverrides.get(key) ?? true, [openOverrides])
  const toggleOpen = useCallback(
    (key: string) => {
      const nextOpen = !isOpen(key)
      setOpenOverrides((prev) => new Map(prev).set(key, nextOpen))
      setExpandedKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    },
    [isOpen],
  )
  // Both setters return the previous state untouched when nothing would
  // change. `goToSlot` (the deep link, the day bar) asks for a slot to be open
  // and expanded, the deep link from an effect; a fresh Set on every call
  // would re-render for nothing, and an effect that read the result would ask
  // again forever.
  const setOpen = useCallback((key: string, open: boolean) => {
    setOpenOverrides((prev) => {
      if ((prev.get(key) ?? true) === open) return prev
      return new Map(prev).set(key, open)
    })
  }, [])
  const setExpanded = useCallback((key: string, expanded: boolean) => {
    setExpandedKeys((prev) => {
      if (prev.has(key) === expanded) return prev
      const next = new Set(prev)
      if (expanded) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  return { isOpen, toggleOpen, expandedKeys, setOpen, setExpanded }
}

/**
 * "Show all N" / "Show less" under a slot's rows.
 *
 * Only a slot still ahead in the day can be in a capped state, so only one of
 * these can ever be showing — a started slot draws all its rows and neither
 * button (see `slotShowsEverything`).
 */
function SlotRowCountToggle({
  count,
  hiddenCount,
  canShowLess,
  onExpand,
}: {
  count: number
  hiddenCount: number
  canShowLess: boolean
  onExpand: (expanded: boolean) => void
}) {
  const className = SLOT_FOOTER_TOGGLE_CLASS
  if (hiddenCount > 0) {
    return (
      <button type="button" onClick={() => onExpand(true)} className={className}>
        Show all {count}
        <span className="text-muted-foreground/60"> ({hiddenCount} more)</span>
      </button>
    )
  }
  if (canShowLess) {
    return (
      <button type="button" onClick={() => onExpand(false)} className={className}>
        Show less
      </button>
    )
  }
  return null
}

/**
 * Carry out a `goToSlot` request for this slot: scroll its section into view,
 * then report the request served (see `goToSlot` in `RemindersView` for why it is one-shot).
 * An effect, so it runs after the commit that opened and expanded the slot and
 * the section is at its full height when it is scrolled to.
 */
export function useSlotScroll<T extends HTMLElement = HTMLDivElement>(
  scrollRequest: number | undefined,
  onScrollServed: ((seq: number) => void) | undefined,
) {
  const sectionRef = useRef<T>(null)
  useEffect(() => {
    if (scrollRequest === undefined) return
    scrollSectionIntoView(sectionRef.current)
    onScrollServed?.(scrollRequest)
  }, [scrollRequest, onScrollServed])
  return sectionRef
}

export function ReminderSlotGroup({
  group,
  started,
  open,
  expanded,
  locked = false,
  slotKey,
  scrollRequest,
  onScrollServed,
  onToggle,
  onExpand,
  completingIds,
  selectedIds,
  isSelectionMode,
  highlightId,
  rowHandlers,
  onCompleteGroup,
  onPutBack,
  onOpenDetail,
}: {
  group: ReminderGroup
  started: boolean
  open: boolean
  expanded: boolean
  /** Search results: the slot cannot be folded and offers no sweep. */
  locked?: boolean
  /** Identity for the `?slot=<slotId>` deep link (`slotGroupKey`'s value) and E2E targeting. */
  slotKey?: string
  /** A pending `goToSlot` request for THIS slot (its sequence number) — the
   *  `?slot=<slotId>` deep link or a tap on the day bar. Scrolls it into view. */
  scrollRequest?: number
  /** The request has been carried out — clear it, so a remount cannot replay it. */
  onScrollServed?: (seq: number) => void
  onToggle: () => void
  onExpand: (expanded: boolean) => void
  completingIds: Set<number | string>
  selectedIds: Set<number | string>
  isSelectionMode: boolean
  highlightId: number | null
  rowHandlers: ReminderRowHandlers
  onCompleteGroup: (group: ReminderGroup) => void
  onPutBack: (task: Task) => void
  /** Open one considered thought in the editor — see `ConsideredDisclosure`. */
  onOpenDetail: (task: Task) => void
}) {
  const label = slotLabel(group)
  const time = group.slot ? formatClockTime(group.slot.start_time) : null
  // Waiting and considered count quota prompts exactly as reminders.
  const count = groupWaiting(group)
  const considered = groupConsidered(group)
  const slotTotal = count + considered
  // A slot with nothing waiting can still open: its considered items live
  // behind the counter, and one of them may need putting back.
  const canOpen = !locked && (count > 0 || hasConsideredRows(group))
  const showsEverything = slotShowsEverything(started, expanded)
  const visible = showsEverything ? group.reminders : group.reminders.slice(0, SLOT_PREVIEW_COUNT)
  const hiddenCount = group.reminders.length - visible.length
  const { renderPrompt, onPutBackPrompt, ...reminderHandlers } = rowHandlers
  const sectionRef = useSlotScroll(scrollRequest, onScrollServed)

  const headerRow = (
    <SlotHeaderRow
      label={label}
      time={time}
      count={count}
      considered={considered}
      open={open}
      started={started}
    />
  )

  return (
    <div
      ref={sectionRef}
      className={cn(
        // Bottom padding in every state, so the hairline sits inside the card
        // rather than flush with its edge when folded.
        'bg-muted/30 rounded-2xl pb-1 transition-colors',
        open && 'pb-2',
        !started && 'opacity-70',
      )}
      data-slot-group={label}
      data-slot-started={started}
      data-slot-key={slotKey}
      // Clears the sticky top bar when `goToSlot` lands this card at the top
      // (the `?slot=<slotId>` deep link, or a tap on the headline's day bar).
      style={{ scrollMarginTop: '4.5rem' }}
    >
      <div className="flex min-h-11 items-center gap-2 px-3">
        {!canOpen ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 py-2">{headerRow}</div>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="hover:text-foreground flex min-w-0 flex-1 items-center gap-2 rounded-lg py-2 text-left transition-colors"
          >
            {headerRow}
          </button>
        )}
        {open && count > 0 && !locked && (
          <button
            type="button"
            onClick={() => onCompleteGroup(group)}
            aria-label={`Mark all ${count} in ${label} as considered`}
            className={SLOT_SWEEP_CLASS}
          >
            <CheckCheck className="size-3.5" strokeWidth={2.5} />
            <span className="hidden sm:inline">Considered all</span>
          </button>
        )}
      </div>

      <SlotHairline label={label} considered={considered} total={slotTotal} />

      {open && (
        <>
          {visible.length > 0 && (
            <ul
              className="space-y-0.5 px-1"
              role="listbox"
              aria-multiselectable="true"
              aria-label={label}
            >
              {visible.map((reminder) => (
                <ReminderRow
                  key={reminder.id}
                  reminder={reminder}
                  completing={completingIds.has(reminder.id)}
                  selected={selectedIds.has(reminder.id)}
                  isSelectionMode={isSelectionMode}
                  highlighted={highlightId === reminder.id}
                  {...reminderHandlers}
                />
              ))}
            </ul>
          )}
          <SlotPromptList
            prompts={group.prompts}
            label={label}
            spaced={visible.length > 0}
            renderPrompt={renderPrompt}
          />
          {!locked && (
            <SlotRowCountToggle
              count={group.reminders.length}
              hiddenCount={hiddenCount}
              canShowLess={
                showsEverything && !started && group.reminders.length > SLOT_PREVIEW_COUNT
              }
              onExpand={onExpand}
            />
          )}
          <ConsideredDisclosure
            group={group}
            label={label}
            onPutBack={onPutBack}
            onPutBackPrompt={onPutBackPrompt}
            onOpenDetail={onOpenDetail}
          />
        </>
      )}
    </div>
  )
}

/**
 * A slot's waiting quota prompts (2026-09-24). Under the slot's reminders,
 * never capped (a slot holds a few). Its own multi-select listbox: a prompt
 * joins a selection beside the reminders (2026-09-25, see `QuotaPromptRow`).
 */
function SlotPromptList({
  prompts,
  label,
  spaced,
  renderPrompt,
}: {
  prompts: QuotaPrompt[]
  label: string
  /** Reminder rows sit above: keep the rows' own rhythm across the seam. */
  spaced: boolean
  renderPrompt: (prompt: QuotaPrompt) => React.ReactNode
}) {
  const waiting = prompts.filter(promptWaiting)
  if (waiting.length === 0) return null
  return (
    <ul
      className={cn('space-y-0.5 px-1', spaced && 'mt-0.5')}
      role="listbox"
      aria-multiselectable="true"
      aria-label={`${label} quotas`}
      data-slot-prompts
    >
      {waiting.map((prompt) => renderPrompt(prompt))}
    </ul>
  )
}

/**
 * The slot header's row: one shape whether the slot is open, folded, finished,
 * or not yet started — chevron box (so the label lands on the rows' x), label,
 * time, spacer, count. The count reads the same open or folded; a later slot
 * says "later"; a finished slot says so in green, with a check mark beside it
 * (2026-09-22) — never a greyed-out one for a slot that isn't finished yet.
 * Never a pill that changes colour when the section folds.
 */
export function SlotHeaderRow({
  label,
  time,
  count,
  considered,
  open,
  started,
  accent,
  doneAccent,
  doneColor,
  emptyDone = false,
}: {
  label: string
  time: string | null
  count: number
  considered: number
  open: boolean
  started: boolean
  /** A colour for the label — a task segment's teal. */
  accent?: string
  /** The finished "N of N" numbers in this colour, not green: the deadlines
   *  page's text teal (`segmentDoneTextColor`). */
  doneAccent?: string
  /** The finished count's ✓ in this colour (a glyph, so the fill teal:
   *  `segmentDoneColor`); without it the ✓ takes the count's colour. */
  doneColor?: string
  /**
   * Empty is DONE (a task segment, Trent 2026-10-24: every segment shows
   * every day, an empty one finished from the start): "0 of 0 ✓", and the
   * chevron stays, since its body has "Nothing today ✓" to show.
   */
  emptyDone?: boolean
}) {
  const total = count + considered
  const finished = count === 0 && (considered > 0 || emptyDone)
  const labelEl = (
    <span
      // May wrap, never truncate: "TASK QUEUE · PREVIOUSLY STAGED" (2026-10-20)
      // is wider than a phone's header beside its count and Considered all,
      // and on one line it ran under the count. A period's name fits as before.
      className="text-muted-foreground min-w-0 text-xs font-semibold tracking-wider text-balance uppercase"
      // A task segment's title wears its horizon's teal (2026-10-11).
      style={accent ? { color: accent } : undefined}
    >
      {label}
    </span>
  )
  // Trent (2026-09-05): the number must not count down as thoughts are
  // considered ("26, 25, 24" felt wrong under a progress bar). It reads
  // "1 of 26, 2 of 26" — the slot's size stays put and the considered
  // count climbs, the same framing as the day number by the bar. A slot
  // that hasn't started and has nothing considered yet just says how many
  // are ahead.
  const counter = finished ? (
    <span
      data-done-count
      className={cn(
        'inline-flex items-center gap-1 text-xs whitespace-nowrap tabular-nums',
        !doneAccent && 'text-green-700 dark:text-green-400',
      )}
      style={doneAccent ? { color: doneAccent } : undefined}
    >
      {considered} of {total}
      {/* Same check mark as the dashboard's slot header (2026-09-22), so a
          finished slot reads the same way on both surfaces. */}
      <Check
        data-done-check
        className="size-3.5"
        style={doneColor ? { color: doneColor } : undefined}
        strokeWidth={2.5}
        aria-hidden="true"
      />
    </span>
  ) : !started && considered === 0 ? (
    <span className="text-muted-foreground text-xs whitespace-nowrap tabular-nums">
      {count} later
    </span>
  ) : (
    <span className="text-xs whitespace-nowrap tabular-nums">
      <span className="text-foreground font-medium">{considered}</span>
      <span className="text-muted-foreground"> of {total}</span>
    </span>
  )
  return (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center">
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'text-muted-foreground/60 size-3.5 transition-transform duration-200',
            !open && '-rotate-90',
            count === 0 && considered === 0 && !emptyDone && 'invisible',
          )}
        />
      </span>
      {labelEl}
      {/* A slot's start time (a task segment has only its title). The one
          part of the header that may give way on a phone; the count beside it
          must never be overlapped. A slot's time always fits. */}
      {/* ~#8a8a8a light, ~#8f8f8f dark — see PanelPagerParts' header. */}
      {time && (
        <span className="text-muted-foreground/80 dark:text-muted-foreground/90 min-w-0 truncate text-xs">
          &middot; {time}
        </span>
      )}
      <span className="flex-1" />
      <span
        aria-label={
          !started && considered === 0
            ? `${count} later`
            : `${considered} of ${total} considered, ${count} waiting`
        }
      >
        {counter}
      </span>
    </>
  )
}

/**
 * Full-width hairline under a slot header: considered over what the slot held
 * today. Long enough that one thought visibly moves it.
 *
 * Also the Quotas surface's period bar (2026-10-16): Trent asked why the
 * quotas' bars were "fat and on the same line as the heading, whereas the ones
 * for the reminders have them casually underneath the heading", so a quota
 * period section draws THIS bar under its heading row (`PeriodHeading` in
 * `TrackPanel`). It passes its own `fraction` (partial credit, capped per
 * quota — `trackSections`), accessible text and inset, since "considered"
 * means nothing there; the look stays this one element's.
 */
export function SlotHairline({
  label,
  considered,
  total,
  doneColor,
  fraction: fractionOverride,
  ariaLabel,
  ariaValueText,
  className = 'mx-3 mb-2',
  ...rest
}: {
  label: string
  considered: number
  total: number
  /** The finished fill in place of green: the deadlines page's teal (`segmentDoneColor`). */
  doneColor?: string
  /** The fill, 0..1, when it is not `considered / total` (a quota period). */
  fraction?: number
  ariaLabel?: string
  ariaValueText?: string
  /** The inset; the slot card's `mx-3 mb-2` by default. */
  className?: string
} & { [data: `data-${string}`]: string | undefined }) {
  const fraction = fractionOverride ?? (total > 0 ? considered / total : 0)
  return (
    <div
      {...rest}
      className={cn('bg-muted h-1 overflow-hidden rounded-full', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={considered}
      aria-valuetext={ariaValueText}
      aria-label={ariaLabel ?? `${considered} of ${total} considered in ${label}`}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width,background-color] duration-500 ease-out',
          // Purple while still filling (a slot, a task segment, a quota
          // period alike), green the moment it's done — matches the
          // dashboard's `ReminderSlotBar` (2026-09-22; purple 2026-10-26).
          fraction >= 1 ? !doneColor && 'bg-green-600' : 'bg-badge-reminders',
        )}
        style={{
          width: `${Math.min(1, fraction) * 100}%`,
          ...(doneColor && fraction >= 1 ? { backgroundColor: doneColor } : {}),
        }}
      />
    </div>
  )
}

/**
 * The slot's considered items, folded behind one line so the list of what is
 * still waiting stays short. Each row is checked and dim; its circle puts the
 * thought back (Trent, 2026-09-05: "if I accidentally press it, undo is not
 * quite enough"). Rows here are not selectable — there is one thing to do
 * with them, and it is on the circle.
 *
 * AMENDED 2026-09-21. "One thing to do with them" turned out to be one thing
 * too few: Trent hit a considered thought whose title he wanted to fix and
 * found no way in — "it only lets me select uncompleted items so there's a
 * bug there". It was not a bug, it was this rule, written when the only
 * concern was an accidental tap (2026-09-05: "if I accidentally press it, undo
 * is not quite enough") and never revisited for the case of simply editing
 * one. So a considered row now takes the same press-and-hold a waiting row
 * does — pointed straight at the editor rather than at a selection, since
 * there is still nothing here worth selecting in bulk.
 */
function ConsideredDisclosure({
  group,
  label,
  onPutBack,
  onPutBackPrompt,
  onOpenDetail,
}: {
  /** Its considered reminders, then its handled quota prompts (2026-09-25). */
  group: ReminderGroup
  label: string
  onPutBack: (task: Task) => void
  onPutBackPrompt: (prompt: QuotaPrompt) => void
  onOpenDetail: (task: Task) => void
}) {
  const [shown, setShown] = useState(false)
  const items = group.consideredItems
  const prompts = group.prompts.filter((p) => !promptWaiting(p))
  if (items.length + prompts.length === 0) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-expanded={shown}
        className={SLOT_FOOTER_TOGGLE_CLASS}
      >
        {shown ? 'Hide' : 'Show'} {items.length + prompts.length} considered
      </button>
      {shown && (
        <ul className="space-y-0.5 px-1" aria-label={`Considered in ${label}`}>
          {items.map((reminder) => (
            <ConsideredRow
              key={reminder.id}
              reminder={reminder}
              onPutBack={onPutBack}
              onOpenDetail={onOpenDetail}
            />
          ))}
          {prompts.map((prompt) => (
            <ConsideredPromptRow
              key={prompt.prompt_key}
              prompt={prompt}
              onPutBack={onPutBackPrompt}
            />
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * Anything behind a slot's "Show N considered": its considered reminders, or
 * a handled quota prompt (which can be put back too, since 2026-09-25).
 */
export function hasConsideredRows(group: ReminderGroup): boolean {
  return group.consideredItems.length > 0 || group.prompts.some((p) => !promptWaiting(p))
}

/**
 * One already-considered thought: a circle that puts it back, and a title that
 * opens the editor on a press-and-hold. Same 400ms gesture as a waiting row,
 * so there is one thing to learn on this surface rather than two.
 */
function ConsideredRow({
  reminder,
  onPutBack,
  onOpenDetail,
}: {
  reminder: Task
  onPutBack: (task: Task) => void
  onOpenDetail: (task: Task) => void
}) {
  const press = useLongPress({ onLongPress: () => onOpenDetail(reminder) })

  return (
    <li
      data-considered-id={reminder.id}
      className="flex items-start gap-3 rounded-xl border border-transparent px-2 py-2.5 select-none"
      onPointerDown={press.onPointerDown}
      onPointerUp={press.onPointerUp}
      onPointerMove={press.onPointerMove}
      onPointerLeave={press.onPointerLeave}
      onPointerCancel={press.onPointerUp}
    >
      <button
        type="button"
        onClick={() => onPutBack(reminder)}
        // The circle keeps its own pointer, so a hold that starts on it never
        // also arms the row's long press — the same guard the dashboard
        // panel's rows use.
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={`Put back "${reminder.title}"`}
        title="Put back"
        className="mt-[3px] flex size-6 shrink-0 items-center justify-center rounded-full bg-green-600 text-white transition-colors hover:bg-green-600/50"
      >
        <Check className="size-3.5" strokeWidth={3} />
      </button>
      <p className="text-muted-foreground min-w-0 flex-1 text-[16px] leading-6">
        <span className="text-pretty">{reminder.title}</span>
      </p>
    </li>
  )
}
