'use client'

import { useEffect, useState } from 'react'
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { toast, Toaster as Sonner, type ToasterProps } from 'sonner'
import { useNativeSnoozeToast } from '@/hooks/useNativeSnoozeToast'

/**
 * Tap-to-dismiss: Sonner v2 doesn't expose an onClick option on toasts or
 * toastOptions, so we attach a single delegated click listener to the toaster
 * container. Clicks on action/cancel buttons are ignored so those still work.
 */
function useTapToDismiss() {
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      // Don't dismiss if the user tapped an action/cancel button inside the toast
      if (target.closest('button')) return
      const toastEl = target.closest('[data-sonner-toast]')
      if (toastEl) toast.dismiss()
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [])
}

/**
 * Is a floating selection bar on screen?
 *
 * Every surface's bar carries `data-selection-sheet` (the dashboard's,
 * Reminders', Quotas'), so one observer covers all of them. Toasts and the bar
 * both live at bottom-centre, and a toast sat squarely on top of the bar —
 * Trent, 2026-09-06: "the undo and redo toasts cover up that floating
 * multi-select thing so I have to wait for all the toasts to go away before I
 * can continue working."
 *
 * Its HEIGHT, zero with none up (2026-11-18): the bar with one task picked
 * is several lines tall (title, details, notes), and a toast placed for the
 * old one-line bar sat on its title — now a button.
 */
function useSelectionSheetHeight(): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    let watched: Element | null = null
    const sizes = new ResizeObserver(() =>
      setHeight((watched as HTMLElement | null)?.offsetHeight ?? 0),
    )
    const check = () => {
      const bar = document.querySelector('[data-selection-sheet]')
      if (bar === watched) return
      sizes.disconnect()
      watched = bar
      if (bar) sizes.observe(bar)
      else setHeight(0)
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      sizes.disconnect()
    }
  }, [])
  return height
}

const Toaster = ({ ...props }: ToasterProps) => {
  useTapToDismiss()
  // Here, not in AppLayout: a toast raised before Sonner subscribes is
  // dropped, and on a cold launch the native result is waiting at mount.
  // This component's effects run after its child <Sonner>'s, so the
  // subscription is always in place first.
  useNativeSnoozeToast()
  const { resolvedTheme } = useTheme()
  const barHeight = useSelectionSheetHeight()

  return (
    <Sonner
      theme={(resolvedTheme as 'light' | 'dark') ?? 'light'}
      richColors
      // A modal dialog (Radix) sets `pointer-events: none` on <body> and the
      // toasts inherit it, so a toast's Undo could not be clicked while a modal
      // was open — the overlay took the click. Process stays open across its
      // toasts, so their Undo has to work (2026-10-10).
      className="toaster group [&_[data-sonner-toast]]:pointer-events-auto"
      // Clear the selection bar when one is up, so the toast and its Undo sit
      // above it rather than across it: the bar's own height, on top of where
      // it sits (bottom-6 on a wide screen, bottom-20 above the phone's tab
      // bar), plus a gap.
      offset={barHeight ? { bottom: `${24 + barHeight + 12}px` } : undefined}
      // Push toasts above the mobile bottom nav bar (~78px + safe area inset + gap).
      // Sonner adds ~9px of internal padding below the toast, so we need extra room.
      mobileOffset={{
        bottom: barHeight
          ? `calc(${80 + barHeight + 16}px + env(safe-area-inset-bottom, 0px))`
          : 'calc(96px + env(safe-area-inset-bottom, 0px))',
      }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
