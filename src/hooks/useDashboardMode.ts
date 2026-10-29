'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { useTaskRowStyle } from '@/hooks/useTaskRowStyle'
import { deviceStore } from '@/lib/device-store'
import { DEFAULT_MODE, isModeId } from '@/lib/modes/registry'
import { DEFAULT_MODE_SORT, isSortId, type ModeSort } from '@/lib/modes/sorts'
import type { ModeId } from '@/lib/modes/types'

/**
 * THE DASHBOARD MODES' device state (Trent, 2026-10-28): which mode — Today,
 * Scan or All — and the sort pill's choice, both remembered per device.
 *
 * ON with the lean row: the modes are built on it, so they come with the
 * device's "Task rows: Lean" or "Card v2" (Settings → Theme; card v2 is the
 * lean row in a card), whose default is the build's
 * (`NEXT_PUBLIC_DEFAULT_TASK_ROWS=lean` on the dev build).
 * Production and CI build without it, so their dashboard is unchanged.
 *
 * `?mode=<id>` (the STABLE id — `today`, `pick-mode`, `all` — never the
 * display word) opens a mode and remembers it.
 */
const modeStore = deviceStore<ModeId>(
  'opentask_dashboard_mode',
  DEFAULT_MODE,
  (raw) => (isModeId(raw) ? raw : null),
  String,
  () => {
    const asked = new URLSearchParams(window.location.search).get('mode')
    return isModeId(asked) ? asked : null
  },
)

const sortStore = deviceStore<ModeSort>(
  'opentask_mode_sort',
  DEFAULT_MODE_SORT,
  (raw) => {
    try {
      const parsed = JSON.parse(raw) as Partial<ModeSort>
      return isSortId(parsed.id) ? { id: parsed.id, everywhere: parsed.everywhere === true } : null
    } catch {
      return null
    }
  },
  (value) => JSON.stringify(value),
)

export function useDashboardMode() {
  const { style } = useTaskRowStyle()
  // The modes ride the lean row's contents: lean rows and card v2 (the lean
  // row in a card) have them; the old cards keep the dashboard as it was.
  const enabled = style !== 'card'
  const stored = useSyncExternalStore(modeStore.subscribe, modeStore.read, modeStore.serverSnapshot)
  const sort = useSyncExternalStore(sortStore.subscribe, sortStore.read, sortStore.serverSnapshot)
  const setMode = useCallback((next: ModeId) => modeStore.write(next), [])
  const setSort = useCallback((next: ModeSort) => sortStore.write(next), [])
  return {
    /** The modes are on (lean rows or card v2). */
    enabled,
    /** The mode shown: the stored one with the modes on; else the dashboard as it was. */
    mode: enabled ? stored : null,
    setMode,
    sort,
    setSort,
  }
}
