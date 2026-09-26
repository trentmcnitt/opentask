/**
 * The pure half of PreferencesProvider: the preferences shape, how a
 * `GET /api/user/preferences` response maps onto it, how that load merges with
 * what the user already changed, and how same-field saves are ordered.
 *
 * Kept free of React so the two races it exists to fix can be unit-tested
 * (tests/behavioral/preferences-merge.test.ts):
 *
 * 1. THE LOAD MUST NOT UNDO A CLICK. The provider starts from hardcoded
 *    defaults and fetches the real values on mount. A click that lands before
 *    that fetch resolves (e.g. opening the dashboard filters right after the
 *    page paints) changes the field and PATCHes it; the fetch then used to
 *    overwrite every field, snapping the UI back while the server kept the
 *    click. `mergeLoadedPrefs` keeps any field the user touched ("dirty") and
 *    takes the server's value only for the rest.
 *
 * 2. THE LAST CLICK WINS, NOT THE LAST ARRIVAL. The view preferences save
 *    fire-and-forget. Two quick toggles sent two overlapping PATCHes; the
 *    server applied whichever arrived last, which need not be the second one.
 *    `createPreferenceSaver` keeps at most one PATCH in flight per field and
 *    holds only the newest value behind it.
 */

import type { LabelConfig, PriorityDisplayConfig } from '@/types'
import type { GroupingMode } from '@/components/TaskList'
import type { SortOption } from '@/hooks/useGroupSort'
import type { AiMode } from '@/hooks/useAiMode'
import type { FeatureMode } from '@/core/ai/user-context'
import type { FeatureInfo, AIFeature } from '@/core/ai/models'

export type FeatureInfoMap = Record<AIFeature, FeatureInfo>

/**
 * What a plain press of the bulk-snooze clock does (Trent, 2026-09-22).
 * `next_period`, the default: snooze to the next time slot to start.
 * `default_option`: the user's default snooze option (+1h unless changed) —
 * the old behaviour, kept as a setting so he can flip between them.
 */
export type BulkSnoozeDefault = 'next_period' | 'default_option'

export const DEFAULT_PRIORITY_DISPLAY: PriorityDisplayConfig = {
  trailingDot: true,
  badgeStyle: 'words',
  colorTitle: false,
  rightBorder: false,
  colorCheckbox: true,
}

export interface Prefs {
  aiAvailable: boolean
  labelConfig: LabelConfig[]
  priorityDisplay: PriorityDisplayConfig
  autoSnoozeDefault: number
  autoSnoozeUrgent: number
  autoSnoozeHigh: number
  autoSnoozeLow: number
  autoSnoozeMedium: number
  defaultSnoozeOption: string
  bulkSnoozeDefault: BulkSnoozeDefault
  morningTime: string
  wakeTime: string
  sleepTime: string
  defaultGrouping: GroupingMode
  defaultSort: SortOption
  defaultSortReversed: boolean
  filtersExpanded: boolean
  trackExpanded: boolean
  quotasDetails: boolean
  notificationsEnabled: boolean
  criticalAlertVolume: number
  aiContext: string | null
  aiMode: AiMode
  aiShowScores: boolean
  aiShowSignals: boolean
  aiEnrichmentMode: FeatureMode
  aiQuickTakeMode: FeatureMode
  aiWhatsNextMode: FeatureMode
  aiInsightsMode: FeatureMode
  aiWnCommentaryUnfiltered: boolean
  aiWnHighlight: boolean
  aiInsightsSignalChips: boolean
  aiInsightsScoreChips: boolean
  aiSdkAvailable: boolean
  aiApiAvailable: boolean
  aiFeatureInfo: FeatureInfoMap | null
}

/** What the UI shows until the preferences fetch lands. */
export const DEFAULT_PREFS: Prefs = {
  aiAvailable: false,
  labelConfig: [],
  priorityDisplay: DEFAULT_PRIORITY_DISPLAY,
  autoSnoozeDefault: 30,
  autoSnoozeUrgent: 5,
  autoSnoozeHigh: 15,
  autoSnoozeLow: 240,
  autoSnoozeMedium: 60,
  defaultSnoozeOption: '60',
  bulkSnoozeDefault: 'next_period',
  morningTime: '09:00',
  wakeTime: '07:00',
  sleepTime: '22:00',
  defaultGrouping: 'project',
  defaultSort: 'due_date',
  defaultSortReversed: false,
  filtersExpanded: false,
  trackExpanded: false,
  quotasDetails: false,
  notificationsEnabled: true,
  criticalAlertVolume: 1.0,
  aiContext: null,
  aiMode: 'on',
  aiShowScores: true,
  aiShowSignals: true,
  aiEnrichmentMode: 'api',
  aiQuickTakeMode: 'api',
  aiWhatsNextMode: 'api',
  aiInsightsMode: 'api',
  aiWnCommentaryUnfiltered: false,
  aiWnHighlight: true,
  aiInsightsSignalChips: true,
  aiInsightsScoreChips: true,
  aiSdkAvailable: false,
  aiApiAvailable: false,
  aiFeatureInfo: null,
}

/** The dashboard's three chips plus 'unified', which the AI-sort toggle drives. */
const VALID_GROUPINGS: GroupingMode[] = ['time', 'project', 'unified', 'slot']

/**
 * Coerce a stored `default_grouping` to a grouping the dashboard can actually render.
 *
 * The Reminders surface used to persist through this same preference (it rode in
 * the view toggle as a chip-that-looked-like-a-tab). It is now its own route, so
 * accounts that were left on 'reminders' hold a value no view corresponds to.
 * Rather than migrate the column, those users land on 'slot' — the §7.3 front door
 * — and the stored value is corrected the next time they pick a view.
 */
export function coerceGrouping(stored: unknown): GroupingMode {
  return VALID_GROUPINGS.includes(stored as GroupingMode) ? (stored as GroupingMode) : 'slot'
}

function featureMode(value: unknown): FeatureMode | undefined {
  return value === 'off' || value === 'sdk' || value === 'api' ? value : undefined
}

/** Copy `value` into `out[key]` when `keep(value)`; the load's "is this field present" test. */
function take<K extends keyof Prefs>(
  out: Partial<Prefs>,
  key: K,
  value: unknown,
  keep: (v: unknown) => boolean = (v) => v !== undefined,
): void {
  if (keep(value)) out[key] = value as Prefs[K]
}

const truthy = (v: unknown) => Boolean(v)

/**
 * Map a `GET /api/user/preferences` `data` object onto `Prefs`, keeping only
 * the fields the response actually carries (and carries validly). The
 * per-field tests are the ones the provider has always applied: a zero
 * auto-snooze or empty time is "absent", an unknown grouping is coerced,
 * `priority_display` is layered over the defaults, an unknown AI mode is 'on'.
 */
export function parseServerPrefs(data: Record<string, unknown> | null | undefined): Partial<Prefs> {
  const out: Partial<Prefs> = {}
  if (!data) return out
  take(out, 'aiAvailable', data.ai_available)
  take(out, 'labelConfig', data.label_config, truthy)
  if (data.priority_display) {
    out.priorityDisplay = {
      ...DEFAULT_PRIORITY_DISPLAY,
      ...(data.priority_display as Partial<PriorityDisplayConfig>),
    }
  }
  take(out, 'autoSnoozeDefault', data.auto_snooze_minutes, truthy)
  take(out, 'autoSnoozeUrgent', data.auto_snooze_urgent_minutes, truthy)
  take(out, 'autoSnoozeLow', data.auto_snooze_low_minutes, truthy)
  take(out, 'autoSnoozeMedium', data.auto_snooze_medium_minutes, truthy)
  take(out, 'autoSnoozeHigh', data.auto_snooze_high_minutes, truthy)
  take(out, 'defaultSnoozeOption', data.default_snooze_option, truthy)
  if (data.bulk_snooze_default === 'default_option' || data.bulk_snooze_default === 'next_period') {
    out.bulkSnoozeDefault = data.bulk_snooze_default
  }
  take(out, 'morningTime', data.morning_time, truthy)
  take(out, 'wakeTime', data.wake_time, truthy)
  take(out, 'sleepTime', data.sleep_time, truthy)
  if (data.default_grouping) out.defaultGrouping = coerceGrouping(data.default_grouping)
  take(out, 'defaultSort', data.default_sort, truthy)
  take(out, 'defaultSortReversed', data.default_sort_reversed)
  take(out, 'filtersExpanded', data.filters_expanded)
  take(out, 'trackExpanded', data.track_expanded)
  take(out, 'quotasDetails', data.quotas_details)
  take(out, 'notificationsEnabled', data.notifications_enabled)
  take(out, 'criticalAlertVolume', data.critical_alert_volume)
  take(out, 'aiContext', data.ai_context)
  // Defensive mapping: accept valid modes, anything else present is 'on'.
  if (data.ai_mode) out.aiMode = data.ai_mode === 'off' ? 'off' : 'on'
  take(out, 'aiShowScores', data.ai_show_scores)
  take(out, 'aiShowSignals', data.ai_show_signals)
  take(out, 'aiEnrichmentMode', featureMode(data.ai_enrichment_mode))
  take(out, 'aiQuickTakeMode', featureMode(data.ai_quicktake_mode))
  take(out, 'aiWhatsNextMode', featureMode(data.ai_whats_next_mode))
  take(out, 'aiInsightsMode', featureMode(data.ai_insights_mode))
  take(out, 'aiWnCommentaryUnfiltered', data.ai_wn_commentary_unfiltered)
  take(out, 'aiWnHighlight', data.ai_wn_highlight)
  take(out, 'aiInsightsSignalChips', data.ai_insights_signal_chips)
  take(out, 'aiInsightsScoreChips', data.ai_insights_score_chips)
  take(out, 'aiSdkAvailable', data.ai_sdk_available)
  take(out, 'aiApiAvailable', data.ai_api_available)
  take(out, 'aiFeatureInfo', data.ai_feature_info, truthy)
  return out
}

/**
 * Apply a preferences load on top of the current state.
 *
 * `local` is the state at the moment the load lands (defaults plus any
 * changes the user made meanwhile), `dirty` the fields the user changed since
 * mount, `server` the parsed response. A dirty field keeps its local value:
 * the user's change is newer than the load (its PATCH went out after the GET
 * was read, or is still in flight), so the server's copy is the stale one.
 * Every other field takes the server's value when the response carries one.
 */
export function mergeLoadedPrefs(
  local: Prefs,
  dirty: ReadonlySet<keyof Prefs>,
  server: Partial<Prefs>,
): Prefs {
  const merged: Prefs = { ...local }
  for (const key of Object.keys(server) as (keyof Prefs)[]) {
    if (dirty.has(key) || server[key] === undefined) continue
    ;(merged as unknown as Record<string, unknown>)[key] = server[key]
  }
  return merged
}

export interface PreferenceSaver {
  /**
   * Save `body` for `field`. Sent at once unless a save for the same field
   * is still in flight; then it waits behind it, replacing any value already
   * waiting there (only the newest click matters).
   */
  save(field: string, body: Record<string, unknown>): void
  /**
   * Send every waiting value now, without waiting for the saves ahead of it.
   * For `pagehide`: a value still waiting when the page goes away would
   * otherwise never be sent.
   */
  flushPending(): void
}

/**
 * Order same-field saves so the last CLICK wins (see point 2 of the module doc).
 *
 * Per field: one save in flight, at most one waiting. When the in-flight save
 * settles (success or failure), the waiting value goes out, unless it equals
 * what was just saved successfully (toggled away and back). No timers: the next send is
 * triggered by the previous one settling. Different fields don't wait on
 * each other.
 *
 * `send` resolves on a save the server accepted and rejects otherwise. A
 * rejection is swallowed, like the fire-and-forget fetch it replaces.
 */
export function createPreferenceSaver(
  send: (body: Record<string, unknown>) => Promise<unknown>,
): PreferenceSaver {
  const inFlight = new Map<string, string>()
  const waiting = new Map<string, Record<string, unknown>>()

  function start(field: string, body: Record<string, unknown>): void {
    const serialized = JSON.stringify(body)
    inFlight.set(field, serialized)
    let saved = false
    send(body)
      .then(() => {
        saved = true
      })
      .catch(() => {})
      .finally(() => {
        inFlight.delete(field)
        const next = waiting.get(field)
        if (next === undefined) return
        waiting.delete(field)
        // Skip a value the server already holds — but only if that save
        // succeeded; after a failure the newest click still has to go out.
        if (saved && JSON.stringify(next) === serialized) return
        start(field, next)
      })
  }

  return {
    save(field, body) {
      if (inFlight.has(field)) {
        waiting.set(field, body)
        return
      }
      start(field, body)
    },
    flushPending() {
      for (const [field, body] of waiting) {
        waiting.delete(field)
        send(body).catch(() => {})
      }
    },
  }
}

/**
 * The set of fields the user changed since the last load (point 1 of the
 * module doc). `take()` hands back the set and starts a fresh one, so each
 * load only protects the changes made before it landed.
 */
export function createDirtyTracker() {
  let dirty = new Set<keyof Prefs>()
  return {
    mark(key: keyof Prefs): void {
      dirty.add(key)
    },
    take(): ReadonlySet<keyof Prefs> {
      const taken = dirty
      dirty = new Set()
      return taken
    },
  }
}
