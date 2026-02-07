'use client'

import { useEffect } from 'react'
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'
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

const Toaster = ({ ...props }: ToasterProps) => {
  useTapToDismiss()

  return (
    <Sonner
      theme="system"
      className="toaster group"
      // Push toasts above the mobile bottom nav bar (~78px + safe area inset + gap).
      // Sonner adds ~9px of internal padding below the toast, so we need extra room.
      mobileOffset={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
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
