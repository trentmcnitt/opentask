/**
 * THE USER'S ANCHOR TIMES (2026-10-21) — the pure resolver.
 *
 * Seven times of day a user sets in Settings: Morning (`morning_time`, the
 * default task time and "Tomorrow"), Wake and Sleep (`wake_time` /
 * `sleep_time`, the waking window), and the number pad's four preset buttons
 * (`pad_presets`). Each is EITHER a custom time OR linked to one of the user's
 * reminder periods (time slots), in which case it follows that period's start.
 *
 * STORED FORM, one shape for all seven: a `(time, slot_id | null)` pair.
 * - Morning, Wake, Sleep: the `*_time` column plus a `*_slot_id` column
 *   (`users`, no foreign key — the `quota_prompt_slot_id` precedent). The
 *   `*_time` column always holds a real time: the custom value, or, when
 *   linked, the period's start as of the link (a snapshot). Readers that only
 *   ever use Morning as the no-periods fallback (`read.ts`'s SQL rollover, the
 *   rollover cron) stay correct by construction: with no periods there can be
 *   no link, so the column IS the resolved time.
 * - The pad: `pad_presets`, a JSON array of exactly 4 pairs, in button order.
 *   NULL is today's four times as custom (`DEFAULT_PAD_PRESETS`), so no
 *   existing user's pad moved when this shipped.
 *
 * THE ONE RULE (`resolveTime`): a link to a period the user still has reads
 * that period's start; anything else reads the stored time. A link to a
 * period that is gone falls back to its snapshot — `deleteTimeSlot` converts
 * links to custom first (`unlinkSlot`), so that is a belt-and-braces path.
 *
 * Every reader goes through this rule — the server through
 * `getAnchorTimes` (`src/core/users/anchor-times.ts`, the only adapter), the
 * browser through the resolved values `GET /api/user/preferences` returns.
 * Nothing else looks the link up.
 *
 * Pure and browser-safe: Settings uses it for the optimistic summary line.
 */

import type { TimeSlot } from '@/lib/time-slot-assign'
import { formatClockTime } from '@/lib/time-utils'

export type AnchorKey = 'morning' | 'wake' | 'sleep'

export const ANCHOR_KEYS: readonly AnchorKey[] = ['morning', 'wake', 'sleep']

/** What the user calls each anchor (Settings, the delete toast). */
export const ANCHOR_NAMES: Record<AnchorKey, string> = {
  morning: 'Morning time',
  wake: 'Wake time',
  sleep: 'Sleep time',
}

/** One stored setting: a custom time, or a link to a period (with its start as a snapshot). */
export interface TimeSetting {
  /** HH:MM local — the custom time, or the linked period's start when linked. */
  time: string
  slot_id: number | null
}

/** A setting as read: its effective time, and the period it follows (if any). */
export interface ResolvedTime {
  /** HH:MM local. */
  time: string
  /** The period it follows, or null for a custom time (or a link to a period that is gone). */
  slot_id: number | null
  slot_label: string | null
}

export interface AnchorTimes {
  morning: ResolvedTime
  wake: ResolvedTime
  sleep: ResolvedTime
  /** The number pad's four buttons, in their stored order. */
  pad: ResolvedTime[]
}

/** The `users` columns behind the seven settings. */
export interface AnchorRow {
  morning_time: string
  morning_slot_id: number | null
  wake_time: string
  wake_slot_id: number | null
  sleep_time: string
  sleep_slot_id: number | null
  pad_presets: string | null
}

export const ANCHOR_COLUMNS: readonly (keyof AnchorRow)[] = [
  'morning_time',
  'morning_slot_id',
  'wake_time',
  'wake_slot_id',
  'sleep_time',
  'sleep_slot_id',
  'pad_presets',
]

export const PAD_PRESET_COUNT = 4

/** The number pad's buttons before a user changes them — the four the pad always had. */
export const DEFAULT_PAD_PRESETS: readonly TimeSetting[] = [
  { time: '09:00', slot_id: null },
  { time: '12:00', slot_id: null },
  { time: '16:00', slot_id: null },
  { time: '20:30', slot_id: null },
]

/** A row with the schema defaults (a missing user; the tests' baseline). */
export const DEFAULT_ANCHOR_ROW: AnchorRow = {
  morning_time: '09:00',
  morning_slot_id: null,
  wake_time: '07:00',
  wake_slot_id: null,
  sleep_time: '22:00',
  sleep_slot_id: null,
  pad_presets: null,
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function isTimeSetting(value: unknown): value is TimeSetting {
  if (!value || typeof value !== 'object') return false
  const { time, slot_id } = value as Record<string, unknown>
  return (
    typeof time === 'string' &&
    HHMM.test(time) &&
    (slot_id === null || (typeof slot_id === 'number' && Number.isInteger(slot_id)))
  )
}

/**
 * The stored pad (`users.pad_presets`): its four settings, or the defaults for
 * NULL, JSON that doesn't parse, or anything that isn't exactly four valid pairs.
 */
export function parsePadPresets(json: string | null | undefined): TimeSetting[] {
  if (!json) return DEFAULT_PAD_PRESETS.map((p) => ({ ...p }))
  try {
    const parsed: unknown = JSON.parse(json)
    if (
      Array.isArray(parsed) &&
      parsed.length === PAD_PRESET_COUNT &&
      parsed.every(isTimeSetting)
    ) {
      return parsed.map((p) => ({ time: p.time, slot_id: p.slot_id }))
    }
  } catch {
    // fall through to the defaults
  }
  return DEFAULT_PAD_PRESETS.map((p) => ({ ...p }))
}

/** The stored JSON for a pad (always the full four, in order). */
export function serializePadPresets(pad: readonly TimeSetting[]): string {
  return JSON.stringify(pad.map((p) => ({ time: p.time, slot_id: p.slot_id })))
}

/** THE rule: a live link reads the period's start, anything else the stored time. */
export function resolveTime(setting: TimeSetting, slots: readonly TimeSlot[]): ResolvedTime {
  const slot = setting.slot_id !== null ? slots.find((s) => s.id === setting.slot_id) : undefined
  if (slot) return { time: slot.start_time, slot_id: slot.id, slot_label: slot.label }
  return { time: setting.time, slot_id: null, slot_label: null }
}

/** The stored (unresolved) setting for one anchor. */
export function anchorSetting(row: AnchorRow, key: AnchorKey): TimeSetting {
  return { time: row[`${key}_time`], slot_id: row[`${key}_slot_id`] }
}

/** Whether any of the seven settings links to a period (else the slots need not be read). */
export function hasAnyLink(row: AnchorRow): boolean {
  return (
    ANCHOR_KEYS.some((key) => row[`${key}_slot_id`] !== null) ||
    parsePadPresets(row.pad_presets).some((p) => p.slot_id !== null)
  )
}

/** All seven, resolved against the user's periods. */
export function resolveAnchorTimes(row: AnchorRow, slots: readonly TimeSlot[]): AnchorTimes {
  return {
    morning: resolveTime(anchorSetting(row, 'morning'), slots),
    wake: resolveTime(anchorSetting(row, 'wake'), slots),
    sleep: resolveTime(anchorSetting(row, 'sleep'), slots),
    pad: parsePadPresets(row.pad_presets).map((p) => resolveTime(p, slots)),
  }
}

/** What the user calls pad button `index` (0-based). */
export function padButtonName(index: number): string {
  return `Pad button ${index + 1}`
}

/**
 * One of the seven settings changing from `before` to `after` — an anchor by
 * key, a pad button by its 0-based index. A period delete records one per
 * setting it converts, in its undo entry (`SlotUndoState.user_settings`).
 */
export interface SettingChange {
  setting: AnchorKey | number
  before: TimeSetting
  after: TimeSetting
}

/** What the user calls a setting ("Morning time", "Pad button 2"). */
export function settingName(setting: AnchorKey | number): string {
  return typeof setting === 'number' ? padButtonName(setting) : ANCHOR_NAMES[setting]
}

function sameSetting(a: TimeSetting, b: TimeSetting): boolean {
  return a.time === b.time && a.slot_id === b.slot_id
}

/**
 * A REMOVED PERIOD'S LINKS BECOME CUSTOM TIMES at the period's own start
 * ("keep the time", Trent 2026-10-21) — not moved to the nearest period the
 * way its reminders and quota prompts are. One change per setting that linked
 * to it (none when nothing did); `settingWrites(row, changes, 'after')` is
 * the update.
 */
export function unlinkSlot(
  row: AnchorRow,
  removed: Pick<TimeSlot, 'id' | 'start_time'>,
): SettingChange[] {
  const after: TimeSetting = { time: removed.start_time, slot_id: null }
  const changes: SettingChange[] = []
  for (const key of ANCHOR_KEYS) {
    const before = anchorSetting(row, key)
    if (before.slot_id === removed.id) changes.push({ setting: key, before, after })
  }
  parsePadPresets(row.pad_presets).forEach((before, index) => {
    if (before.slot_id === removed.id) changes.push({ setting: index, before, after })
  })
  return changes
}

/**
 * The `users` column writes that move each setting in `changes` to its
 * `side` — 'after' to apply (the delete, a redo), 'before' to undo.
 *
 * COMPARE-AND-SET, per setting: a setting is written only while it still
 * reads exactly as the other side left it. Preferences are not undo entries
 * and don't clear the redo stack, so a Morning the user set to 7:00 after the
 * delete must survive undoing the delete — the newer choice wins. (The
 * default prompt period, `SlotUndoState.prompt_default`, is written back
 * without this check; it predates it.) Per setting, never per column: a
 * custom 7:00 shares its `slot_id` (null) with the converted value, and
 * writing the id back alone would re-link it.
 */
export function settingWrites(
  row: AnchorRow,
  changes: readonly SettingChange[],
  side: 'before' | 'after',
): Partial<AnchorRow> {
  const from = side === 'after' ? 'before' : 'after'
  const writes: Partial<AnchorRow> = {}
  const pad = parsePadPresets(row.pad_presets)
  let padChanged = false
  for (const change of changes) {
    const target = change[side]
    if (typeof change.setting === 'number') {
      const i = change.setting
      if (i < 0 || i >= pad.length || !sameSetting(pad[i], change[from])) continue
      pad[i] = { ...target }
      padChanged = true
    } else {
      const key = change.setting
      if (!sameSetting(anchorSetting(row, key), change[from])) continue
      writes[`${key}_time`] = target.time
      writes[`${key}_slot_id`] = target.slot_id
    }
  }
  if (padChanged) writes.pad_presets = serializePadPresets(pad)
  return writes
}

/** Settings' summary line: "Morning · 8:30 AM (Morning period)". */
export function anchorLabel(name: string, resolved: ResolvedTime): string {
  const time = formatClockTime(resolved.time)
  return resolved.slot_label
    ? `${name} · ${time} (${resolved.slot_label} period)`
    : `${name} · ${time}`
}
