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
            <div className="space-y-1 px-4 pb-4">
              {options.map((opt) => (
                <button
                  key={opt.option}
                  type="button"
                  disabled={opt.disabled}
                  onClick={(e) => {
                    if (isChoice(e)) onSelect(opt.option)
                  }}
                  className="hover:bg-accent active:bg-accent flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors disabled:pointer-events-none disabled:opacity-40"
                >
                  <span className="text-muted-foreground [&_svg]:size-4">{opt.icon}</span>
                  {opt.label}
                  <Caption text={opt.caption} />
                </button>
              ))}
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
          className="w-auto min-w-[200px] p-1"
          // Focus stays where it was: the trigger's own keys still work.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {options.map((opt) => (
            <OptionItem key={opt.option} opt={opt} isChoice={isChoice} onSelect={onSelect} />
          ))}
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
    } else {
      menu.style.top = `${rect.bottom + 4}px` // 4px gap below
    }
  }, [triggerRef])

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
      className="bg-popover text-popover-foreground fixed z-50 min-w-[200px] rounded-md border p-1 shadow-md"
      style={{ transform: 'translateX(-100%)' }}
    >
      {options.map((opt) => (
        <OptionItem key={opt.option} opt={opt} isChoice={isChoice} onSelect={onSelect} />
      ))}
    </div>,
    document.body,
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
      {opt.label}
      <Caption text={opt.caption} />
    </button>
  )
}
