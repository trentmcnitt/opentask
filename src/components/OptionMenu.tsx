'use client'

import { useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useIsMobile } from '@/hooks/useIsMobile'
import { cn } from '@/lib/utils'

/**
 * THE HOLD MENU's shell, shared by the snooze/target menu (`SnoozeMenu`) and
 * the On deck menu (`DeckMenu`, 2026-10-20): a bottom sheet on a phone, a
 * portalled dropdown at the trigger on a wider screen. The options are the
 * caller's; so is the open state — the trigger is rendered as-is, never
 * wrapped in a Radix trigger, because its caller runs its own tap/hold.
 * Moved out of `SnoozeMenu` unchanged when the On deck menu needed the same
 * shell.
 */
export interface OptionMenuItem {
  label: string
  option: string
  icon: React.ReactNode
  /** Shown but not choosable (the On deck menu's days after a deadline's start, A1). */
  disabled?: boolean
  /** A short note after the label — why a disabled option is ("deadline reminds from Tue"). */
  caption?: string
  /**
   * Drawn as a BUTTON in a wrapping row under this small heading, with the
   * group's other consecutive items (T1's periods, 2026-10-30): a long list
   * of short choices that stays a few lines tall. The caption sits inside
   * the button, after the label; the icon isn't drawn.
   */
  chipGroup?: string
}

type MenuPart =
  | { kind: 'item'; opt: OptionMenuItem }
  | { kind: 'chips'; label: string; items: OptionMenuItem[] }

/** The options as drawn: single rows, and each run of one `chipGroup` as one part. */
function menuParts(options: OptionMenuItem[]): MenuPart[] {
  const parts: MenuPart[] = []
  for (const opt of options) {
    const last = parts.at(-1)
    if (!opt.chipGroup) parts.push({ kind: 'item', opt })
    else if (last?.kind === 'chips' && last.label === opt.chipGroup) last.items.push(opt)
    else parts.push({ kind: 'chips', label: opt.chipGroup, items: [opt] })
  }
  return parts
}

/** A chip group: its heading, then its buttons, wrapping. */
function ChipGroup({
  label,
  items,
  isChoice,
  onSelect,
  large,
}: {
  label: string
  items: OptionMenuItem[]
  isChoice: (e: React.MouseEvent) => boolean
  onSelect: (option: string) => void
  /** The phone sheet's size; the desktop dropdown's is smaller. */
  large: boolean
}) {
  return (
    <div data-option-chips={label} role="group" aria-label={label} className="px-2 pt-2 pb-1">
      <p className="text-muted-foreground mb-1.5 text-[11px] font-medium tracking-wider uppercase">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">
        {items.map((opt) => (
          <button
            key={opt.option}
            type="button"
            role="menuitem"
            data-option-chip={opt.option}
            disabled={opt.disabled}
            onClick={(e) => {
              if (isChoice(e)) onSelect(opt.option)
            }}
            className={cn(
              'hover:bg-accent active:bg-accent rounded-full border whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-40',
              large ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-1 text-xs',
            )}
          >
            {opt.label}{' '}
            {opt.caption && <span className="text-muted-foreground ml-1">{opt.caption}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

/** An option's caption, quieter than its label. */
function Caption({ text }: { text?: string }) {
  if (!text) return null
  return (
    <span data-option-caption className="text-muted-foreground ml-auto pl-3 text-xs">
      {text}
    </span>
  )
}

/**
 * Whether a click on an option is a real choice. A menu opened by a HOLD
 * opens under the finger that is still down: on a phone the sheet slides up
 * beneath it, and lifting that finger clicks whichever option is now there —
 * the Today button's hold picked "Next period" that way (2026-10-14). So an
 * option only counts once a new press has begun since the menu opened; a
 * keyboard's click (`detail` 0) always counts.
 */
export function useChoiceGuard(open: boolean): (e: React.MouseEvent) => boolean {
  const armed = useRef(false)
  useEffect(() => {
    if (!open) return
    armed.current = false
    const arm = () => {
      armed.current = true
    }
    document.addEventListener('pointerdown', arm, true)
    return () => document.removeEventListener('pointerdown', arm, true)
  }, [open])
  return (e) => armed.current || e.detail === 0
}

export function OptionMenu({
  open,
  onOpenChange,
  title,
  options,
  onSelect,
  children,
  after,
  anchored = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The sheet's title; the dropdown's accessible name is "<title> options". */
  title: string
  options: OptionMenuItem[]
  onSelect: (option: string) => void
  /** The trigger. */
  children?: React.ReactNode
  /** Rendered beside the menu (the callers' own pickers, which open from it). */
  after?: React.ReactNode
  /**
   * Desktop: a Radix popover anchored at the trigger instead of the hand-made
   * portal dropdown. It joins Radix's layer stack, so it works INSIDE a
   * dialog — the Quick panel's On deck line (D2 review): the hand-made one
   * sits under the dialog's pointer-events lock, and a click on it counts as
   * a click outside the dialog.
   */
  anchored?: boolean
}) {
  const isMobile = useIsMobile()
  const triggerRef = useRef<HTMLDivElement>(null)
  const isChoice = useChoiceGuard(open)

  if (isMobile) {
    return (
      <>
        {children}
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton={false}>
            <SheetHeader>
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription className="sr-only">Choose when</SheetDescription>
            </SheetHeader>
            {/* Never taller than the screen (2026-10-30): with many options
                the list scrolls under its title instead of pushing the
                title and the first options off the top. */}
            <div className="max-h-[calc(100dvh-8rem)] space-y-1 overflow-y-auto overscroll-contain px-4 pb-4">
              {menuParts(options).map((part) =>
                part.kind === 'chips' ? (
                  <ChipGroup
                    key={`chips:${part.label}`}
                    label={part.label}
                    items={part.items}
                    isChoice={isChoice}
                    onSelect={onSelect}
                    large
                  />
                ) : (
                  <button
                    key={part.opt.option}
                    type="button"
                    disabled={part.opt.disabled}
                    onClick={(e) => {
                      if (isChoice(e)) onSelect(part.opt.option)
                    }}
                    className="hover:bg-accent active:bg-accent flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors disabled:pointer-events-none disabled:opacity-40"
                  >
                    <span className="text-muted-foreground [&_svg]:size-4">{part.opt.icon}</span>
                    {part.opt.label} <Caption text={part.opt.caption} />
                  </button>
                ),
              )}
            </div>
            <div className="h-6 sm:hidden" />
          </SheetContent>
        </Sheet>
        {after}
      </>
    )
  }

  if (anchored) {
    return (
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverAnchor asChild>
          <div className="relative inline-flex">{children}</div>
        </PopoverAnchor>
        <PopoverContent
          data-no-row-press
          role="menu"
          aria-label={`${title} options`}
          align="end"
          className={cn(
            'max-h-[var(--radix-popover-content-available-height)] w-auto max-w-[22rem] min-w-[200px] overflow-y-auto p-1',
            options.some((o) => o.chipGroup) && 'w-[20rem]',
          )}
          // Focus stays where it was: the trigger's own keys still work.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <MenuItems options={options} isChoice={isChoice} onSelect={onSelect} />
        </PopoverContent>
        {after}
      </Popover>
    )
  }

  // Desktop: portal-rendered dropdown positioned via getBoundingClientRect.
  // This escapes all stacking contexts (SwipeableRow's position:relative)
  // so the dropdown renders above subsequent task rows.
  return (
    <div ref={triggerRef} className="relative inline-flex">
      {children}
      {open && (
        <OptionDropdown
          triggerRef={triggerRef}
          options={options}
          label={`${title} options`}
          onSelect={onSelect}
          isChoice={isChoice}
          onClose={() => onOpenChange(false)}
        />
      )}
      {after}
    </div>
  )
}

/**
 * Desktop dropdown rendered via portal into document.body, positioned using
 * the trigger's bounding rect. This fully escapes SwipeableRow stacking contexts.
 *
 * Uses pointerdown (not click) for outside detection so that the pointer-up
 * after a long-press doesn't immediately close the dropdown. The originating
 * pointerdown has already fired before the dropdown mounts, so it can't
 * accidentally trigger the outside handler.
 */
function OptionDropdown({
  triggerRef,
  options,
  label,
  onSelect,
  isChoice,
  onClose,
}: {
  triggerRef: React.RefObject<HTMLDivElement | null>
  options: OptionMenuItem[]
  label: string
  onSelect: (option: string) => void
  isChoice: (e: React.MouseEvent) => boolean
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Position from the trigger's bounding rect, written straight onto the menu
  // element in a layout effect — before paint, so it never flashes elsewhere.
  // Below the trigger by default; ABOVE it when the trigger sits in the lower
  // half of the viewport — the snooze-all FAB lives in the bottom-right corner
  // (Trent, 2026-09-28), where a menu opened downward is off-screen.
  useLayoutEffect(() => {
    const menu = ref.current
    if (!triggerRef.current || !menu) return
    // Measure the trigger itself, not the wrapper: a `fixed` trigger (the FAB)
    // leaves its in-flow wrapper somewhere else entirely.
    const trigger = triggerRef.current.firstElementChild ?? triggerRef.current
    const rect = trigger.getBoundingClientRect()
    menu.style.left = `${rect.right}px` // right-aligned with trigger
    if (rect.top > window.innerHeight / 2) {
      menu.style.bottom = `${window.innerHeight - rect.top + 4}px` // 4px gap above
      menu.style.maxHeight = `${rect.top - 12}px`
    } else {
      menu.style.top = `${rect.bottom + 4}px` // 4px gap below
      menu.style.maxHeight = `${window.innerHeight - rect.bottom - 12}px`
    }
  }, [triggerRef])
  // (Never past the window's edge: `maxHeight` above, and the list scrolls.)

  // Close on pointerdown outside. Using pointerdown instead of click prevents
  // the pointer-up from a long-press (which synthesizes a click) from closing
  // the dropdown immediately after it opens.
  const handlePointerDownOutside = useCallback(
    (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    },
    [onClose],
  )

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  useEffect(() => {
    document.addEventListener('pointerdown', handlePointerDownOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [handlePointerDownOutside, handleKeyDown])

  return createPortal(
    <div
      ref={ref}
      data-no-row-press
      role="menu"
      aria-label={label}
      className={cn(
        'bg-popover text-popover-foreground fixed z-50 max-w-[22rem] min-w-[200px] overflow-y-auto overscroll-contain rounded-md border p-1 shadow-md',
        // A chip group wraps across the menu's width: give it one, or the
        // rows' width leaves one chip per line (T1's periods, 2026-10-30).
        options.some((o) => o.chipGroup) && 'w-[20rem]',
      )}
      style={{ transform: 'translateX(-100%)' }}
    >
      <MenuItems options={options} isChoice={isChoice} onSelect={onSelect} />
    </div>,
    document.body,
  )
}

/** The desktop menu's rows and chip groups, in order. */
function MenuItems({
  options,
  isChoice,
  onSelect,
}: {
  options: OptionMenuItem[]
  isChoice: (e: React.MouseEvent) => boolean
  onSelect: (option: string) => void
}) {
  return menuParts(options).map((part) =>
    part.kind === 'chips' ? (
      <ChipGroup
        key={`chips:${part.label}`}
        label={part.label}
        items={part.items}
        isChoice={isChoice}
        onSelect={onSelect}
        large={false}
      />
    ) : (
      <OptionItem key={part.opt.option} opt={part.opt} isChoice={isChoice} onSelect={onSelect} />
    ),
  )
}

/** One desktop menu row. */
function OptionItem({
  opt,
  isChoice,
  onSelect,
}: {
  opt: OptionMenuItem
  isChoice: (e: React.MouseEvent) => boolean
  onSelect: (option: string) => void
}) {
  return (
    <button
      role="menuitem"
      type="button"
      disabled={opt.disabled}
      aria-disabled={opt.disabled || undefined}
      onClick={(e) => {
        if (isChoice(e)) onSelect(opt.option)
      }}
      className={cn(
        'hover:bg-accent active:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm whitespace-nowrap transition-colors',
        'disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 [&_svg]:flex-shrink-0',
      )}
    >
      {opt.icon}
      {opt.label} <Caption text={opt.caption} />
    </button>
  )
}
