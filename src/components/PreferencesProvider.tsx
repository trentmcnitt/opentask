'use client'

import { createContext, useContext, useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import type { LabelConfig, PriorityDisplayConfig } from '@/types'
import type { GroupingMode } from '@/components/TaskList'
import type { SortOption } from '@/hooks/useGroupSort'
import type { AiMode } from '@/hooks/useAiMode'
import type { FeatureMode } from '@/core/ai/user-context'
import type { FeatureInfo } from '@/core/ai/models'
import {
  DEFAULT_PREFS,
  DEFAULT_PRIORITY_DISPLAY,
  createDirtyTracker,
  createPreferenceSaver,
  mergeLoadedPrefs,
  parseServerPrefs,
  type BulkSnoozeDefault,
  type FeatureInfoMap,
  type Prefs,
} from '@/lib/preferences-state'

export type { FeatureMode, FeatureInfo, FeatureInfoMap, BulkSnoozeDefault }

interface PreferencesContextValue {
  aiAvailable: boolean
  labelConfig: LabelConfig[]
  setLabelConfig: (config: LabelConfig[]) => void
  priorityDisplay: PriorityDisplayConfig
  setPriorityDisplay: (config: PriorityDisplayConfig) => void
  autoSnoozeDefault: number
  setAutoSnoozeDefault: (minutes: number) => void
  autoSnoozeUrgent: number
  setAutoSnoozeUrgent: (minutes: number) => void
  autoSnoozeHigh: number
  /** §4.1 cadence ladder — P1 and P2 get their own intervals. */
  autoSnoozeLow: number
  autoSnoozeMedium: number
  setAutoSnoozeHigh: (minutes: number) => void
  setAutoSnoozeLow: (minutes: number) => void
  setAutoSnoozeMedium: (minutes: number) => void
  defaultSnoozeOption: string
  setDefaultSnoozeOption: (option: string) => void
  /** What a plain press of the bulk-snooze clock does — see `BulkSnoozeDefault`. */
  bulkSnoozeDefault: BulkSnoozeDefault
  setBulkSnoozeDefault: (value: BulkSnoozeDefault) => void
  morningTime: string
  setMorningTime: (time: string) => void
  wakeTime: string
  setWakeTime: (time: string) => void
  sleepTime: string
  setSleepTime: (time: string) => void
  defaultGrouping: GroupingMode
  setDefaultGrouping: (grouping: GroupingMode) => void
  /**
   * True once the `/api/user/preferences` fetch below has settled (success
   * or failure). Until then `defaultGrouping` (and everything else in this
   * context) is the hardcoded fallback above, not the user's real value —
   * see `useDefaultGrouping`'s doc comment for why a consumer that needs the
   * REAL grouping (not just "a" grouping) has to wait on this.
   */
  preferencesLoaded: boolean
  defaultSort: SortOption
  defaultSortReversed: boolean
  setSortPreference: (sort: SortOption, reversed: boolean) => void
  /** §7.3 — dashboard filter-chip section pinned open by the user. */
  filtersExpanded: boolean
  setFiltersExpanded: (expanded: boolean) => void
  /** §5 — the Track panel pinned open by the user (it starts folded). */
  trackExpanded: boolean
  setTrackExpanded: (expanded: boolean) => void
  notificationsEnabled: boolean
  setNotificationsEnabled: (enabled: boolean) => void
  criticalAlertVolume: number
  setCriticalAlertVolume: (volume: number) => void
  aiContext: string | null
  setAiContext: (context: string | null) => void
  aiMode: AiMode
  setAiMode: (mode: AiMode) => void
  aiShowScores: boolean
  setAiShowScores: (show: boolean) => void
  aiShowSignals: boolean
  setAiShowSignals: (show: boolean) => void
  aiEnrichmentMode: FeatureMode
  setAiEnrichmentMode: (mode: FeatureMode) => void
  aiQuickTakeMode: FeatureMode
  setAiQuickTakeMode: (mode: FeatureMode) => void
  aiWhatsNextMode: FeatureMode
  setAiWhatsNextMode: (mode: FeatureMode) => void
  aiInsightsMode: FeatureMode
  setAiInsightsMode: (mode: FeatureMode) => void
  aiWnCommentaryUnfiltered: boolean
  setAiWnCommentaryUnfiltered: (show: boolean) => void
  aiWnHighlight: boolean
  setAiWnHighlight: (show: boolean) => void
  aiInsightsSignalChips: boolean
  setAiInsightsSignalChips: (show: boolean) => void
  aiInsightsScoreChips: boolean
  setAiInsightsScoreChips: (show: boolean) => void
  aiSdkAvailable: boolean
  aiApiAvailable: boolean
  aiFeatureInfo: FeatureInfoMap | null
  setAiFeatureInfo: (info: FeatureInfoMap) => void
}

const PreferencesContext = createContext<PreferencesContextValue>({
  aiAvailable: false,
  labelConfig: [],
  setLabelConfig: () => {},
  priorityDisplay: DEFAULT_PRIORITY_DISPLAY,
  setPriorityDisplay: () => {},
  autoSnoozeDefault: 30,
  setAutoSnoozeDefault: () => {},
  autoSnoozeUrgent: 5,
  setAutoSnoozeUrgent: () => {},
  autoSnoozeHigh: 15,
  autoSnoozeLow: 240,
  autoSnoozeMedium: 60,
  setAutoSnoozeHigh: () => {},
  setAutoSnoozeLow: () => {},
  setAutoSnoozeMedium: () => {},
  defaultSnoozeOption: '60',
  setDefaultSnoozeOption: () => {},
  bulkSnoozeDefault: 'next_period',
  setBulkSnoozeDefault: () => {},
  morningTime: '09:00',
  setMorningTime: () => {},
  wakeTime: '07:00',
  setWakeTime: () => {},
  sleepTime: '22:00',
  setSleepTime: () => {},
  defaultGrouping: 'project',
  setDefaultGrouping: () => {},
  preferencesLoaded: false,
  defaultSort: 'due_date',
  defaultSortReversed: false,
  setSortPreference: () => {},
  filtersExpanded: false,
  setFiltersExpanded: () => {},
  trackExpanded: false,
  setTrackExpanded: () => {},
  notificationsEnabled: true,
  setNotificationsEnabled: () => {},
  criticalAlertVolume: 1.0,
  setCriticalAlertVolume: () => {},
  aiContext: null,
  setAiContext: () => {},
  aiMode: 'on',
  setAiMode: () => {},
  aiShowScores: true,
  setAiShowScores: () => {},
  aiShowSignals: true,
  setAiShowSignals: () => {},
  aiEnrichmentMode: 'api',
  setAiEnrichmentMode: () => {},
  aiQuickTakeMode: 'api',
  setAiQuickTakeMode: () => {},
  aiWhatsNextMode: 'api',
  setAiWhatsNextMode: () => {},
  aiInsightsMode: 'api',
  setAiInsightsMode: () => {},
  aiWnCommentaryUnfiltered: false,
  setAiWnCommentaryUnfiltered: () => {},
  aiWnHighlight: true,
  setAiWnHighlight: () => {},
  aiInsightsSignalChips: true,
  setAiInsightsSignalChips: () => {},
  aiInsightsScoreChips: true,
  setAiInsightsScoreChips: () => {},
  aiSdkAvailable: false,
  aiApiAvailable: false,
  aiFeatureInfo: null,
  setAiFeatureInfo: () => {},
})

// Register the iOS APNs device token with the server using session cookie auth.
// Called after preferences load and on late token arrival (CustomEvent).
function registerDeviceToken() {
  const info = (window as unknown as Record<string, unknown>).__OPENTASK_DEVICE_INFO as
    | { token: string; bundleId: string; environment: string }
    | undefined
  if (!info?.token) return

  fetch('/api/push/apns/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_token: info.token,
      bundle_id: info.bundleId,
      environment: info.environment,
    }),
  }).catch(() => {})
}

// Auto-provision a Bearer token for iOS notification actions (Done, Snooze).
// The native app and notification extensions can't use session cookies, so they
// need a Bearer token stored in the Keychain. This provisions one automatically
// via session cookie auth, eliminating manual token setup.
function provisionBearerToken() {
  // Only run inside the iOS native wrapper (device info is injected by AppDelegate)
  const info = (window as unknown as Record<string, unknown>).__OPENTASK_DEVICE_INFO as
    | { token: string }
    | undefined
  if (!info?.token) return

  const hasLocalToken = (window as unknown as Record<string, unknown>).__OPENTASK_HAS_TOKEN === true

  // Last 8 chars of the keychain token (matches api_tokens.token_preview). Lets the
  // server detect a token belonging to a *different* user — e.g. after an account switch
  // in the webview — instead of assuming any local token is this user's. Older app builds
  // don't inject it, so the field is omitted when unavailable.
  const localTokenPreview = (window as unknown as Record<string, unknown>).__OPENTASK_TOKEN_PREVIEW

  const payload: { has_local_token: boolean; local_token_preview?: string } = {
    has_local_token: hasLocalToken,
  }
  if (typeof localTokenPreview === 'string' && localTokenPreview.length > 0) {
    payload.local_token_preview = localTokenPreview
  }

  fetch('/api/tokens/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data?.data?.token) {
        // New token provisioned — send to native via JS bridge
        const w = window as unknown as {
          webkit?: {
            messageHandlers?: { opentask?: { postMessage: (msg: unknown) => void } }
          }
        }
        w.webkit?.messageHandlers?.opentask?.postMessage({
          action: 'provisionToken',
          token: data.data.token,
        })
      }
    })
    .catch(() => {})
}

type FieldSet = <K extends keyof Prefs>(key: K, value: Prefs[K]) => void

/** The context's plain setters: each changes one field (and marks it dirty) via `set`. */
function makeFieldSetters(set: FieldSet) {
  const field =
    <K extends keyof Prefs>(key: K) =>
    (value: Prefs[K]) =>
      set(key, value)
  return {
    setField: set,
    setLabelConfig: field('labelConfig'),
    setPriorityDisplay: field('priorityDisplay'),
    setAutoSnoozeDefault: field('autoSnoozeDefault'),
    setAutoSnoozeUrgent: field('autoSnoozeUrgent'),
    setAutoSnoozeHigh: field('autoSnoozeHigh'),
    setAutoSnoozeLow: field('autoSnoozeLow'),
    setAutoSnoozeMedium: field('autoSnoozeMedium'),
    setDefaultSnoozeOption: field('defaultSnoozeOption'),
    setBulkSnoozeDefault: field('bulkSnoozeDefault'),
    setMorningTime: field('morningTime'),
    setWakeTime: field('wakeTime'),
    setSleepTime: field('sleepTime'),
    setNotificationsEnabled: field('notificationsEnabled'),
    setCriticalAlertVolume: field('criticalAlertVolume'),
    setAiContext: field('aiContext'),
    setAiMode: field('aiMode'),
    setAiShowScores: field('aiShowScores'),
    setAiShowSignals: field('aiShowSignals'),
    setAiEnrichmentMode: field('aiEnrichmentMode'),
    setAiQuickTakeMode: field('aiQuickTakeMode'),
    setAiWhatsNextMode: field('aiWhatsNextMode'),
    setAiInsightsMode: field('aiInsightsMode'),
    setAiWnCommentaryUnfiltered: field('aiWnCommentaryUnfiltered'),
    setAiWnHighlight: field('aiWnHighlight'),
    setAiInsightsSignalChips: field('aiInsightsSignalChips'),
    setAiInsightsScoreChips: field('aiInsightsScoreChips'),
    setAiFeatureInfo: field('aiFeatureInfo'),
  }
}

/**
 * The view preferences below (grouping, sort, filters fold, Track panel) are
 * saved FIRE-AND-FORGET: state flips at once and the PATCH goes out behind
 * it. Every one of those PATCHes is `keepalive: true`, because a plain fetch is
 * cancelled when the page unloads — toggle a view and reload (or navigate)
 * before the PATCH lands and the browser aborts it, the server may never apply
 * it, and the page comes back showing the old choice. `keepalive` lets the
 * request outlive the page; the bodies are a few bytes, far under its 64 KB cap.
 *
 * Two races around that, both handled in `@/lib/preferences-state` (see its
 * module doc):
 * - Every setter marks its field DIRTY. When the mount fetch lands it merges
 *   with `mergeLoadedPrefs`, which leaves dirty fields alone, so a click made
 *   before the load isn't undone by it. The dirty set is cleared once merged.
 * - The PATCHes go through one `createPreferenceSaver`, so a field has at most
 *   one save in flight and the newest click is sent after it, never raced
 *   against it. A save still waiting behind another when the page is hidden
 *   is sent right away on `pagehide` (keepalive carries it past the unload).
 */
export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const [dirty] = useState(createDirtyTracker)
  const [saver] = useState(() =>
    createPreferenceSaver((body) =>
      fetch('/api/user/preferences', {
        method: 'PATCH',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ),
  )

  // Created once, so every plain setter keeps one identity for the provider's
  // lifetime, as the useState setters they replace did (consumers list them
  // in effect and callback deps).
  const [setters] = useState(() =>
    makeFieldSetters((key, value) => {
      // Mark it so the mount load won't overwrite it (see the doc above).
      dirty.mark(key)
      setPrefs((prev) => ({ ...prev, [key]: value }))
    }),
  )
  const { setField, ...plainSetters } = setters

  useEffect(() => {
    function onPageHide() {
      saver.flushPending()
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [saver])

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/user/preferences')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const server = parseServerPrefs(data?.data)
        // Take (and reset) the dirty set now: a change made after this point
        // is applied by its own state update, which React queues after this merge.
        const changed = dirty.take()
        setPrefs((local) => mergeLoadedPrefs(local, changed, server))

        // Register iOS device token and provision Bearer token using session cookie auth.
        // This ensures push notifications follow the web-logged-in user,
        // not the bearer token user from initial iOS setup.
        registerDeviceToken()
        provisionBearerToken()
      })
      .catch((err: unknown) => {
        console.error('Failed to fetch preferences:', err)
      })
      .finally(() => {
        setPreferencesLoaded(true)
      })
  }, [status, dirty])

  // Handle late APNs token arrival — iOS dispatches this CustomEvent when
  // the device token arrives after the WebView has already loaded.
  useEffect(() => {
    if (status !== 'authenticated') return

    function onDeviceToken() {
      registerDeviceToken()
      provisionBearerToken()
    }

    window.addEventListener('opentask-device-token', onDeviceToken)
    return () => window.removeEventListener('opentask-device-token', onDeviceToken)
  }, [status])

  return (
    <PreferencesContext.Provider
      value={{
        ...prefs,
        ...plainSetters,
        setDefaultGrouping: (grouping: GroupingMode) => {
          setField('defaultGrouping', grouping)
          saver.save('default_grouping', { default_grouping: grouping })
        },
        preferencesLoaded,
        setSortPreference: (sort: SortOption, reversed: boolean) => {
          setField('defaultSort', sort)
          setField('defaultSortReversed', reversed)
          saver.save('default_sort', { default_sort: sort, default_sort_reversed: reversed })
        },
        setFiltersExpanded: (expanded: boolean) => {
          if (expanded === prefs.filtersExpanded) return
          setField('filtersExpanded', expanded)
          saver.save('filters_expanded', { filters_expanded: expanded })
        },
        setTrackExpanded: (expanded: boolean) => {
          if (expanded === prefs.trackExpanded) return
          setField('trackExpanded', expanded)
          saver.save('track_expanded', { track_expanded: expanded })
        },
      }}
    >
      {children}
    </PreferencesContext.Provider>
  )
}

export function useLabelConfig() {
  const { labelConfig, setLabelConfig } = useContext(PreferencesContext)
  return { labelConfig, setLabelConfig }
}

export function usePriorityDisplay() {
  const { priorityDisplay, setPriorityDisplay } = useContext(PreferencesContext)
  return { priorityDisplay, setPriorityDisplay }
}

export function useAutoSnoozeDefault() {
  const {
    autoSnoozeDefault,
    setAutoSnoozeDefault,
    autoSnoozeUrgent,
    setAutoSnoozeUrgent,
    autoSnoozeHigh,
    setAutoSnoozeHigh,
    autoSnoozeLow,
    setAutoSnoozeLow,
    autoSnoozeMedium,
    setAutoSnoozeMedium,
  } = useContext(PreferencesContext)
  return {
    autoSnoozeDefault,
    setAutoSnoozeDefault,
    autoSnoozeUrgent,
    setAutoSnoozeUrgent,
    autoSnoozeHigh,
    setAutoSnoozeHigh,
    autoSnoozeLow,
    setAutoSnoozeLow,
    autoSnoozeMedium,
    setAutoSnoozeMedium,
  }
}

export function useSnoozePreferences() {
  const {
    defaultSnoozeOption,
    setDefaultSnoozeOption,
    bulkSnoozeDefault,
    setBulkSnoozeDefault,
    morningTime,
    setMorningTime,
  } = useContext(PreferencesContext)
  return {
    defaultSnoozeOption,
    setDefaultSnoozeOption,
    bulkSnoozeDefault,
    setBulkSnoozeDefault,
    morningTime,
    setMorningTime,
  }
}

export function useSchedulePreferences() {
  const { wakeTime, setWakeTime, sleepTime, setSleepTime } = useContext(PreferencesContext)
  return { wakeTime, setWakeTime, sleepTime, setSleepTime }
}

/**
 * `groupingLoaded` is `preferencesLoaded` under this hook's own name: until
 * the `/api/user/preferences` fetch settles, `defaultGrouping` is the
 * hardcoded `'project'` fallback in this file, not the user's real
 * preference. Most consumers render fine either way — the fallback just
 * flashes briefly. But `DashboardClient`'s `?task=<id>&highlight=1` effect
 * groups tasks BY `defaultGrouping` to find and expand the linked row, and
 * resolving that against the fallback (rather than waiting a beat for the
 * real value) can expand the wrong group — found by browser-verifying
 * against Trent's own dev account, whose real default is `'slot'`.
 */
export function useDefaultGrouping() {
  const { defaultGrouping, setDefaultGrouping, preferencesLoaded } = useContext(PreferencesContext)
  return { defaultGrouping, setDefaultGrouping, groupingLoaded: preferencesLoaded }
}

export function useDefaultSort() {
  const { defaultSort, defaultSortReversed, setSortPreference } = useContext(PreferencesContext)
  return { defaultSort, defaultSortReversed, setSortPreference }
}

/**
 * §7.3 — whether the user has pinned the dashboard's filter-chip section open.
 * Server-persisted like the other dashboard view preferences (grouping, sort),
 * so the choice follows the user across devices. See `useFilterSection`, which
 * layers the filter-driven auto-expand on top of this.
 */
export function useFilterSectionPreference() {
  const { filtersExpanded, setFiltersExpanded } = useContext(PreferencesContext)
  return { filtersExpanded, setFiltersExpanded }
}

/** §5 — whether the Track panel is pinned open. Starts folded; the user's choice sticks. */
export function useTrackPanelPreference() {
  const { trackExpanded, setTrackExpanded } = useContext(PreferencesContext)
  return { trackExpanded, setTrackExpanded }
}

export function useAiContext() {
  const { aiContext, setAiContext } = useContext(PreferencesContext)
  return { aiContext, setAiContext }
}

export function useNotificationConfig() {
  const {
    notificationsEnabled,
    setNotificationsEnabled,
    criticalAlertVolume,
    setCriticalAlertVolume,
  } = useContext(PreferencesContext)
  return {
    notificationsEnabled,
    setNotificationsEnabled,
    criticalAlertVolume,
    setCriticalAlertVolume,
  }
}

export function useAiPreferences() {
  const {
    aiMode,
    setAiMode,
    aiShowScores,
    setAiShowScores,
    aiShowSignals,
    setAiShowSignals,
    aiEnrichmentMode,
    setAiEnrichmentMode,
    aiQuickTakeMode,
    setAiQuickTakeMode,
    aiWhatsNextMode,
    setAiWhatsNextMode,
    aiInsightsMode,
    setAiInsightsMode,
    aiWnCommentaryUnfiltered,
    setAiWnCommentaryUnfiltered,
    aiWnHighlight,
    setAiWnHighlight,
    aiInsightsSignalChips,
    setAiInsightsSignalChips,
    aiInsightsScoreChips,
    setAiInsightsScoreChips,
    aiSdkAvailable,
    aiApiAvailable,
  } = useContext(PreferencesContext)
  return {
    aiMode,
    setAiMode,
    aiShowScores,
    setAiShowScores,
    aiShowSignals,
    setAiShowSignals,
    aiEnrichmentMode,
    setAiEnrichmentMode,
    aiQuickTakeMode,
    setAiQuickTakeMode,
    aiWhatsNextMode,
    setAiWhatsNextMode,
    aiInsightsMode,
    setAiInsightsMode,
    aiWnCommentaryUnfiltered,
    setAiWnCommentaryUnfiltered,
    aiWnHighlight,
    setAiWnHighlight,
    aiInsightsSignalChips,
    setAiInsightsSignalChips,
    aiInsightsScoreChips,
    setAiInsightsScoreChips,
    aiSdkAvailable,
    aiApiAvailable,
  }
}

export function useAiAvailable() {
  return useContext(PreferencesContext).aiAvailable
}

export function useAiFeatureInfo() {
  const { aiFeatureInfo, setAiFeatureInfo } = useContext(PreferencesContext)
  return { aiFeatureInfo, setAiFeatureInfo }
}
