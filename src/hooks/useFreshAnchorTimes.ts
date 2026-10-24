'use client'

import { useEffect, useState } from 'react'
import { useAnchorTimes } from '@/components/PreferencesProvider'

/**
 * Settings: whether the anchor times (Default task time, Wake, Sleep, Day
 * starts at, the number pad) have been read fresh since the page opened.
 *
 * Read on opening, and again whenever the window comes back into focus — a
 * period or setting changed in another tab or on another device shows before
 * the user edits from a stale copy. Until the first read succeeds the
 * provider may hold its defaults or a value another tab has since changed: a
 * row drawn then showed "Morning · 9:00 AM, Custom time" for a linked setting
 * (seen on dev, 2026-10-21), and a pick made in that moment would have saved
 * from it. So the anchor rows wait for this AND for a successful read of the
 * period list.
 *
 * Called ONCE, by the Settings page, and handed to every section with anchor
 * rows (Your day, Number pad) — each calling it would read the preferences
 * twice on opening and on every focus.
 */
export function useFreshAnchorTimes(): boolean {
  const { reloadPreferences } = useAnchorTimes()
  const [fresh, setFresh] = useState(false)
  useEffect(() => {
    let cancelled = false
    const reload = () =>
      void reloadPreferences().then((ok) => {
        if (!cancelled && ok) setFresh(true)
      })
    reload()
    window.addEventListener('focus', reload)
    return () => {
      cancelled = true
      window.removeEventListener('focus', reload)
    }
  }, [reloadPreferences])
  return fresh
}
