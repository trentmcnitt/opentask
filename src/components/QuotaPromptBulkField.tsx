'use client'

import { useMemo, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { usePromptSetup } from '@/components/QuotaPromptField'
import {
  assignDailyNumbers,
  isDailyQuota,
  promptEnabled,
  resolvePromptSlot,
} from '@/lib/quota-prompts'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { QuotaFreq } from '@/lib/track'
import type { QuotaPromptConfig, Task } from '@/types'

/**
 * The "Remind me daily" section for SEVERAL quotas at once (2026-09-25) — the
 * Quotas page's multi-edit, where Trent selected ten quotas to give them all a
 * reminder period and found no way to.
 *
 * It follows the rest of that editor's rule, "only what you change is
 * applied", with the same three states every multi-edit field has: a value the
 * selection agrees on, and "—" where it disagrees (the mark `LabelField` and
 * the task panel use for a mixed field).
 *
 * - The switch is on, off, or mixed. A switch cannot draw "mixed", so a mixed
 *   one sits unchecked with the dash beside it and says so underneath. It is
 *   sent only if flipped away from what the selection agreed on.
 * - "Reminds me in" chips, in the user's period order, pressed where the
 *   selection agrees. Hidden while the switch reads off (nothing reminds, so
 *   there is nowhere to remind), and when the user has no periods at all.
 *   Choosing one does NOT switch anything on — only what you change.
 *
 * Choosing a period for a DAILY quota with several numbers: `slot_id` becomes
 * that period and every per-number override is cleared (`numbers: {}`), so the
 * numbers spread one per period from there, exactly as a fresh daily quota's
 * do. The alternative, putting every number in that one period, would collapse
 * a 3-a-day quota into a single row (the server shows one row per quota per
 * period), which throws away the numbering the daily prompts exist for.
 *
 * The request carries only the changed fields; `bulkEdit` merges them over
 * each quota's stored config (`mergePromptConfig`), so nothing unchanged is
 * dropped — including a move made from another tab since this opened.
 */

/** What the selection agrees on; `undefined` where it disagrees. */
interface BulkPromptBase {
  enabled: boolean | undefined
  slotId: number | undefined
}

export interface BulkPromptDraft {
  /** The partial config to send — only what was changed. */
  config: QuotaPromptConfig
  touched: boolean
  reset: () => void
  enabled: boolean | undefined
  setEnabled: (value: boolean) => void
  slotId: number | undefined
  setSlotId: (value: number) => void
  slots: TimeSlot[]
  /** Some selected quota counts several times a day (its numbers spread). */
  anySpread: boolean
}

/**
 * The multi-edit's staged "Remind me daily". `period` / `periodTouched` are the
 * editor's draft: a period chosen in the same edit decides the default switch
 * state of a quota with no explicit one, the way `QuotaPromptSection` does for
 * a single quota.
 */
export function useBulkPromptDraft(
  tasks: Task[],
  period: QuotaFreq | null,
  periodTouched: boolean,
): BulkPromptDraft {
  const { slots, userDefault } = usePromptSetup()
  const base = useMemo(
    () => describeBulkBase(tasks, slots, userDefault, periodTouched ? period : undefined),
    [tasks, slots, userDefault, period, periodTouched],
  )
  // `null` = not chosen in this edit; the base shows through.
  const [enabledChoice, setEnabledChoice] = useState<boolean | null>(null)
  const [slotChoice, setSlotChoice] = useState<number | null>(null)

  const enabledTouched = enabledChoice !== null && enabledChoice !== base.enabled
  const slotTouched = slotChoice !== null && slotChoice !== base.slotId
  const config: QuotaPromptConfig = {}
  if (enabledTouched) config.enabled = enabledChoice
  if (slotTouched) {
    config.slot_id = slotChoice
    // Clears every per-number override: see the file header.
    config.numbers = {}
  }

  const daily = (t: Task) => (periodTouched ? period === 'DAILY' : isDailyQuota(t))
  return {
    config,
    touched: enabledTouched || slotTouched,
    reset: () => {
      setEnabledChoice(null)
      setSlotChoice(null)
    },
    enabled: enabledChoice ?? base.enabled,
    setEnabled: setEnabledChoice,
    slotId: slotChoice ?? base.slotId,
    setSlotId: setSlotChoice,
    slots,
    anySpread: tasks.some((t) => daily(t) && (t.progress_target ?? 1) > 1),
  }
}

/**
 * Each quota's switch and period as the Reminders surface would resolve them,
 * reduced across the selection. `draftPeriod` is set only when the edit is
 * changing every quota's period, which changes their defaults.
 *
 * A daily quota whose numbers are placed by hand (anywhere other than the plain
 * spread from its base) has no single period, so it counts as disagreeing —
 * pressing its base chip would claim a placement it does not have.
 */
function describeBulkBase(
  tasks: Task[],
  slots: TimeSlot[],
  userDefault: number | null,
  draftPeriod: QuotaFreq | null | undefined,
): BulkPromptBase {
  const enabled = new Set<boolean>()
  const periods = new Set<number | string>()
  for (const task of tasks) {
    const cfg = task.quota_prompt_config
    enabled.add(
      draftPeriod === undefined
        ? promptEnabled(task)
        : (cfg?.enabled ?? (draftPeriod !== null && draftPeriod !== 'YEARLY')),
    )
    const index = resolvePromptSlot(slots, cfg?.slot_id, userDefault)
    const daily = draftPeriod === undefined ? isDailyQuota(task) : draftPeriod === 'DAILY'
    periods.add(
      index < 0
        ? 'none'
        : daily && placedByHand(task, slots, userDefault)
          ? task.id
          : slots[index].id,
    )
  }
  const [onlyPeriod] = periods
  return {
    enabled: enabled.size === 1 ? [...enabled][0] : undefined,
    slotId: periods.size === 1 && typeof onlyPeriod === 'number' ? onlyPeriod : undefined,
  }
}

/** Does this daily quota's placement differ from the plain spread from its base? */
function placedByHand(task: Task, slots: TimeSlot[], userDefault: number | null): boolean {
  const cfg = task.quota_prompt_config
  if (!cfg?.numbers) return false
  const target = Math.max(1, task.progress_target ?? 1)
  const actual = assignDailyNumbers(target, slots, cfg, userDefault)
  const spread = assignDailyNumbers(target, slots, { slot_id: cfg.slot_id }, userDefault)
  return actual.some((slotIndex, i) => slotIndex !== spread[i])
}

export function QuotaPromptBulkField({ draft }: { draft: BulkPromptDraft }) {
  const { enabled, slotId, slots } = draft
  return (
    <fieldset className="space-y-2" aria-label="Quota reminders" data-quota-prompt-field="many">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Remind me daily</span>
        <div className="flex items-center gap-2">
          {enabled === undefined && (
            <span className="text-muted-foreground text-sm" data-quota-prompt-mixed="enabled">
              —
            </span>
          )}
          <Switch
            checked={enabled === true}
            onCheckedChange={(checked) => draft.setEnabled(checked)}
            aria-label="Remind me daily"
            data-quota-prompt-enabled
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        {enabled === undefined
          ? 'On for some of these, off for others. Left as it is unless you change it.'
          : enabled
            ? 'Shows up among your reminders until it is met.'
            : 'Only on the Quotas page — no daily reminder.'}
      </p>
      {enabled !== false && slots.length > 0 && (
        <div className="space-y-1.5 pt-1" data-quota-prompt-periods>
          <p className="text-muted-foreground text-xs">
            Reminds me in
            {draft.anySpread && ' — a quota counted several times a day starts here and spreads'}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {slotId === undefined && (
              <span className="text-muted-foreground text-sm" data-quota-prompt-mixed="slot">
                —
              </span>
            )}
            {slots.map((slot) => {
              const pressed = slotId === slot.id
              return (
                <button
                  key={slot.id}
                  type="button"
                  onClick={() => draft.setSlotId(slot.id)}
                  aria-pressed={pressed}
                  data-quota-prompt-slot={slot.id}
                  className={cn(
                    'rounded-full border px-3 py-1 text-sm transition-colors',
                    pressed
                      ? 'border-foreground bg-foreground text-background'
                      : 'hover:border-foreground/40',
                  )}
                >
                  {slot.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </fieldset>
  )
}
