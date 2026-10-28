'use client'

import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCheckInDay } from '@/components/PreferencesProvider'
import {
  HORIZON_LABELS,
  HORIZON_UNSET_LABEL,
  HORIZON_WORD,
  horizonHints,
} from '@/lib/task-model-words'
import { HORIZON_ORDER, type HorizonValue } from '@/lib/task-segments'
import { HORIZON_DOT, HORIZON_DOT_UNSET, horizonDotTitle, horizonOf } from '@/lib/row-corner'
import type { Task } from '@/types'

/**
 * The HORIZON DOT (2026-10-14, Trent's pick "R1 · perspective dot"): one dot
 * that shrinks and fades with distance — Days big and dark, Eventually small
 * and light — and a hollow Weeks-size ring for unset (`HORIZON_DOT_UNSET`). Sizes and opacities
 * are `HORIZON_DOT` in `src/lib/row-corner.ts`. Drawn in the foreground
 * colour at 78%, so it follows the theme.
 */
export function HorizonDotMark({
  horizon,
  className,
}: {
  horizon: HorizonValue | null
  className?: string
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      data-horizon-mark={horizon ?? 'unset'}
      // `size-3` also keeps the menu items' `[&_svg:not([class*='size-'])]:size-4` off it.
      className={cn('text-foreground/80 size-3 shrink-0', className)}
    >
      {horizon ? (
        <circle
          cx="6"
          cy="6"
          r={HORIZON_DOT[horizon].r}
          fill="currentColor"
          opacity={HORIZON_DOT[horizon].opacity}
        />
      ) : (
        <circle
          cx="6"
          cy="6"
          r={HORIZON_DOT_UNSET.r}
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          opacity={HORIZON_DOT_UNSET.opacity}
        />
      )}
    </svg>
  )
}

/**
 * The horizon menu's items (spec §3): the four horizons, each with its dot and
 * when its segment comes round ("Weeks · Saturdays"), then Unset — read as
 * weeks, never shown as if the user had said so. Shared by the dot (dashboard
 * and segment rows) and the editor's chip (`HorizonChip`).
 */
export function HorizonMenuContent({
  value,
  onChange,
  align = 'end',
}: {
  value: HorizonValue | null
  onChange: (horizon: HorizonValue | null) => void
  align?: 'start' | 'end'
}) {
  const { checkInDay } = useCheckInDay()
  const hints = horizonHints(checkInDay)
  return (
    <DropdownMenuContent
      align={align}
      className="min-w-52"
      // Portalled, but React events still bubble to the row, whose click
      // selects or opens the task (dashboard) or considers it (segments).
      // Not pointerdown: see `HorizonDotButton`.
      data-no-row-press
      onClick={(e) => e.stopPropagation()}
    >
      <DropdownMenuLabel>{HORIZON_WORD}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={value ?? 'unset'}
        onValueChange={(v) => onChange(v === 'unset' ? null : (v as HorizonValue))}
      >
        {HORIZON_ORDER.map((h) => (
          <DropdownMenuRadioItem key={h} value={h} data-horizon-option={h}>
            <HorizonDotMark horizon={h} />
            {HORIZON_LABELS[h]}
            <span className="text-muted-foreground ml-auto pl-4 text-xs">{hints[h]}</span>
          </DropdownMenuRadioItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuRadioItem value="unset" data-horizon-option="unset">
          <HorizonDotMark horizon={null} />
          {HORIZON_UNSET_LABEL} (weeks)
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  )
}

/**
 * The dot as a button that opens the horizon menu — on the dashboard row's
 * corner (`variant="corner"`) and in place of the segment row's old chevron
 * (`variant="inline"`). Hover shows "Weeks · comes back Saturdays"
 * (`horizonDotTitle`). A change goes through the caller's PATCH, with Undo on
 * its toast.
 *
 * HIT TARGET without growing the row: at least 32px with a mouse and 44px
 * with a finger (`pointer-coarse`). The corner tab is 24×18, so its `before:`
 * box reaches DOWN and LEFT into the row (never up, past the row's border, into
 * the gap or the row above). The inline dot is a 32/44px box pulled back to
 * the row's line height by negative margins, as the segment rows' Today does.
 *
 * Clicks never reach the row. Pointerdown is stopped only on the segment rows
 * (as their chevron did): on the dashboard row the swipe (use-gesture with
 * `filterTaps`) swallows any click whose pointerdown it never saw, which would
 * eat the menu's choices — so there it passes, and `data-no-row-press` keeps
 * the row's long-press (selection) from starting instead.
 *
 * Without `onChange` (a host that does not wire horizon changes) it is the
 * same mark with its tooltip, and nothing to press.
 */
export function HorizonDotButton({
  task,
  onChange,
  variant,
  className,
  onOpen,
}: {
  task: Pick<Task, 'horizon' | 'title' | 'deadline_at' | 'due_at'>
  onChange?: (horizon: HorizonValue | null) => void
  /**
   * 'meta': the segment row's meta line (task queue on) — opens details
   * (`onOpen`), never a menu; without `onOpen` (the row's peek bubble) just
   * the mark and its tooltip.
   */
  variant: 'corner' | 'inline' | 'meta'
  className?: string
  /** 'meta' only: open the task's details. */
  onOpen?: () => void
}) {
  const { checkInDay } = useCheckInDay()
  const horizon = horizonOf(task.horizon)
  const title = horizonDotTitle(task, checkInDay, new Date())
  const shape = cn(
    'relative flex shrink-0 items-center justify-center',
    variant === 'corner' && 'bg-muted h-[18px] min-w-6 px-[6px]',
    // In a segment row's button group, its place there (`SLOT_HIT` in
    // TaskSegmentRow): 34×44px in px at any text size (2026-10-26).
    variant === 'inline' && '-my-[11px] h-[44px] w-[34px] rounded-md',
    // A segment row's meta line (task queue PR 3): just the mark, in the
    // line's flow, beside the project and priority.
    variant === 'meta' && 'size-3',
    className,
  )
  const data = { 'data-horizon-dot': horizon ?? 'unset', 'data-horizon-chip': '' }
  if (variant === 'meta' && onOpen) {
    // The segment row's meta line (task queue on): a press opens the task's
    // details, where the horizon is changed — never the row's consider.
    return (
      <button
        type="button"
        data-horizon-dot={horizon ?? 'unset'}
        data-horizon-meta
        title={title}
        aria-label={`${HORIZON_WORD}: ${title}. Details`}
        onClick={(e) => {
          e.stopPropagation()
          onOpen?.()
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(
          shape,
          // A bigger hit box than the 12px mark, without moving the line.
          'cursor-pointer touch-manipulation rounded-sm before:absolute before:-inset-2 hover:opacity-70',
        )}
      >
        <HorizonDotMark horizon={horizon} />
      </button>
    )
  }
  if (!onChange) {
    return (
      <span {...data} title={title} className={shape}>
        <HorizonDotMark horizon={horizon} />
      </span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        {...data}
        data-no-row-press
        onClick={(e) => e.stopPropagation()}
        onPointerDown={variant === 'inline' ? (e) => e.stopPropagation() : undefined}
        title={title}
        aria-label={`${HORIZON_WORD}: ${title}. Change`}
        className={cn(
          shape,
          'cursor-pointer touch-manipulation',
          'data-[state=open]:ring-ring data-[state=open]:ring-[1.5px] data-[state=open]:ring-inset',
          variant === 'corner'
            ? // The enlarged hit box (see above): 32×32, or 44×44 for a finger.
              'hover:bg-foreground/10 before:absolute before:top-0 before:right-0 before:-bottom-3.5 before:-left-2 pointer-coarse:before:-bottom-[26px] pointer-coarse:before:-left-5'
            : 'hover:bg-foreground/5',
        )}
      >
        <HorizonDotMark horizon={horizon} />
      </DropdownMenuTrigger>
      <HorizonMenuContent value={horizon} onChange={onChange} />
    </DropdownMenu>
  )
}

/**
 * The task editor's horizon control (2026-10-15, Trent: "why can't i set the
 * horizon here?"): the dot and the word, in the Quick panel's chip row beside
 * the project and priority, opening the same menu as the rows' dot. ALWAYS
 * offered on a one-off: with a target of its own the horizon decides nothing
 * until the target goes (spec §1), but it is still the task's pace, and
 * setting it then is how it is ready for when the target is removed — the
 * line under the chips says it isn't in effect meanwhile (`ThisOneFields`).
 * Staged like the other chips: a blue dot while dirty, saved with the rest.
 */
export function HorizonPicker({
  value,
  dirty,
  onChange,
}: {
  value: HorizonValue | null
  dirty: boolean
  onChange: (horizon: HorizonValue | null) => void
}) {
  const label = value ? HORIZON_LABELS[value] : HORIZON_UNSET_LABEL
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-quick-panel-horizon
        data-horizon-picker={value ?? 'unset'}
        aria-label={`${HORIZON_WORD}: ${label}. Change`}
        title={`${HORIZON_WORD}: ${label}`}
        className={cn(
          'hover:bg-foreground/5 inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs font-medium',
          value ? 'text-foreground/70' : 'text-muted-foreground/70 italic',
        )}
      >
        {dirty && <span className="mr-0.5 text-blue-500 not-italic">●</span>}
        <HorizonDotMark horizon={value} />
        {label}
        <ChevronDown className="size-3 opacity-50" />
      </DropdownMenuTrigger>
      <HorizonMenuContent value={value} onChange={onChange} align="start" />
    </DropdownMenu>
  )
}
