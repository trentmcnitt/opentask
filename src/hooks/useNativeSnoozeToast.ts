'use client'

import { useEffect } from 'react'
import { showToast } from '@/lib/toast'
import { bulkSnoozeMessage } from '@/lib/snooze'
import { APP_ACTIVE_EVENT } from '@/hooks/useSyncStream'

/** The event the iOS app fires once a Home Screen quick action's snooze lands. */
export const NATIVE_SNOOZED_EVENT = 'opentask-native-snoozed'

/** The bulk snooze response fields the native app hands over (the API's own names). */
interface NativeSnoozeResult {
  tasks_affected: number
  snoozed_high: number
  skipped_high: number
  /** The TOTAL skipped on priority, as in the API — Urgent is this minus `skipped_high`. */
  skipped_urgent: number
}

declare global {
  interface Window {
    __opentaskNativeSnooze?: NativeSnoozeResult
  }
}

/**
 * The "Snoozed N tasks · Undo" toast for a snooze the iOS app did natively,
 * from a Home Screen quick action (Trent, 2026-09-28: iOS opens the app for
 * one anyway, so the toast is the confirmation — and the chance to undo).
 *
 * The native side (`WebViewManager.deliverSnoozeResult`) sets
 * `window.__opentaskNativeSnooze` and fires `opentask-native-snoozed`. Both,
 * because on a cold launch the result can be delivered before React mounts
 * this hook — then the global is read on mount — while a warm launch has the
 * page up already and the event is what arrives.
 *
 * Undo is a plain `POST /api/undo`, not the page's session-scoped undo: that
 * one only reaches actions newer than the page's load, and on a cold launch
 * the snooze can land before the page records where its session starts. The
 * toast appears the moment the snooze lands, so the latest action is it.
 * Mounted once, in the app's `Toaster` (see the comment there), so it works on
 * whichever page is showing.
 */
export function useNativeSnoozeToast() {
  useEffect(() => {
    const show = () => {
      const result = window.__opentaskNativeSnooze
      if (!result) return
      delete window.__opentaskNativeSnooze
      // Pages refresh on the sync stream anyway; this makes it immediate.
      window.dispatchEvent(new CustomEvent(APP_ACTIVE_EVENT))
      const affected = result.tasks_affected
      showToast({
        message: bulkSnoozeMessage({
          affected,
          highAffected: result.snoozed_high,
          high: result.skipped_high,
          urgent: result.skipped_urgent - result.skipped_high,
        }),
        type: 'success',
        action: affected > 0 ? { label: 'Undo', onClick: undoLatest } : undefined,
      })
    }
    show()
    window.addEventListener(NATIVE_SNOOZED_EVENT, show)
    return () => window.removeEventListener(NATIVE_SNOOZED_EVENT, show)
  }, [])
}

async function undoLatest() {
  try {
    const res = await fetch('/api/undo', { method: 'POST' })
    if (!res.ok) {
      showToast({ message: 'Nothing to undo' })
      return
    }
    const data = await res.json()
    window.dispatchEvent(new CustomEvent(APP_ACTIVE_EVENT))
    showToast({ message: `Undid: ${data.data.description}`, type: 'success' })
  } catch {
    showToast({ message: 'Undo failed', type: 'error' })
  }
}
