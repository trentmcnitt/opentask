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
 */
function useSelectionSheetPresent(): boolean {
  const [present, setPresent] = useState(false)
  useEffect(() => {
    const check = () => setPresent(!!document.querySelector('[data-selection-sheet]'))
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return present
}

const Toaster = ({ ...props }: ToasterProps) => {
  useTapToDismiss()
  const { resolvedTheme } = useTheme()
  const selectionSheet = useSelectionSheetPresent()

  return (
    <Sonner
      theme={(resolvedTheme as 'light' | 'dark') ?? 'light'}
      richColors
      className="toaster group"
      // Clear the selection bar when one is up, so the toast and its Undo sit
      // above it rather than across it. The bar is 56px tall and sits at
      // bottom-6 on a wide screen and bottom-20 above the phone's tab bar;
      // these are those plus a gap.
      offset={selectionSheet ? { bottom: '92px' } : undefined}
      // Push toasts above the mobile bottom nav bar (~78px + safe area inset + gap).
      // Sonner adds ~9px of internal padding below the toast, so we need extra room.
      mobileOffset={{
        bottom: selectionSheet
          ? 'calc(152px + env(safe-area-inset-bottom, 0px))'
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
