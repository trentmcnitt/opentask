'use client'

import { useCallback, useEffect, useState } from 'react'
import { slotGroupKey } from '@/lib/reminder-slots'
import { parsePromptKey, promptWaiting, type QuotaPrompt } from '@/lib/quota-prompts'
import type { ReminderGroup } from '@/hooks/useReminders'

/**
 * `?prompt=<prompt_key>` — the Reminders widget's deep link for a quota PROMPT
 * row (2026-09-27; `PromptDeepLink` in ios/Shared). The prompt twin of
 * `?reminder=<id>`: a prompt tapped on the Reminders widget opens THIS
 * surface — not Quotas — with that row brought on screen and flashed once,
 * nothing opened.
 *
 * Keyed by `prompt_key` (`q:<taskId>:<k>:<date>`), never task id: a daily
 * quota's rows in different slots share one task id, and the link names the
 * one that was tapped.
 *
 * - A WAITING row is highlighted, its slot opened first (the same
 *   open-and-uncap `?reminder=` does; prompts are never capped, but a slot
 *   folded earlier would leave the row unrendered).
 * - A key from another day (a widget last drawn before midnight) matches
 *   today's row for the same quota and number, if one is waiting.
 * - A row already HANDLED (on another device, or before the widget redrew)
 *   lives behind its slot's "Show N considered", which the link does not
 *   take over: it goes to that slot instead (`goToSlot`, the `?slot=` move
 *   in `RemindersView`), highlighting nothing.
 * - Nothing found: the surface opens as it would unlinked.
 *
 * Consumed once, found or not, once the fetch has resolved (`hydrated`, the
 * same reason as `?reminder=`), and only its own param is deleted.
 */
export function usePromptDeepLink({
  hydrated,
  error,
  groups,
  setOpen,
  setExpanded,
  goToSlot,
}: {
  hydrated: boolean
  error: string | null
  groups: ReminderGroup[]
  setOpen: (key: string, open: boolean) => void
  setExpanded: (key: string, expanded: boolean) => void
  goToSlot: (key: string) => void
}) {
  const [highlightPromptKey, setHighlightPromptKey] = useState<string | null>(null)
  const clearPromptHighlight = useCallback(() => setHighlightPromptKey(null), [])
  // Resolved during render, not in an effect (`TaskList`'s highlight-cap
  // pattern, react.dev "Adjusting state when a prop changes"): what it sets is
  // this surface's own state, derived from data it already has. `hydrated` is
  // only ever true on the client, after the first fetch, so reading the URL
  // here never runs on the server. `linkRead` is the guard: once, found or not.
  const [linkRead, setLinkRead] = useState(false)
  if (!linkRead && hydrated && !error) {
    setLinkRead(true)
    const raw = new URLSearchParams(window.location.search).get('prompt')
    const found = raw ? findLinkedPrompt(groups, raw) : null
    if (found && promptWaiting(found.prompt)) {
      const key = slotGroupKey(found.group)
      setOpen(key, true)
      setExpanded(key, true)
      setHighlightPromptKey(found.prompt.prompt_key)
    } else if (found) {
      goToSlot(slotGroupKey(found.group))
    }
  }
  // Spending the param is the one side effect, so it is the effect: only its
  // own param, so a reload does not flash the row again.
  useEffect(() => {
    if (!linkRead) return
    const params = new URLSearchParams(window.location.search)
    if (!params.has('prompt')) return
    params.delete('prompt')
    const query = params.toString()
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + (query ? `?${query}` : ''),
    )
  }, [linkRead])
  return { highlightPromptKey, clearPromptHighlight }
}

/**
 * The prompt a `?prompt=<key>` link names: that exact key, else — for a key
 * from another day — today's WAITING row of the same quota and number.
 */
function findLinkedPrompt(
  groups: ReminderGroup[],
  raw: string,
): { group: ReminderGroup; prompt: QuotaPrompt } | null {
  for (const group of groups) {
    const prompt = group.prompts.find((p) => p.prompt_key === raw)
    if (prompt) return { group, prompt }
  }
  const parsed = parsePromptKey(raw)
  if (!parsed) return null
  for (const group of groups) {
    const prompt = group.prompts.find((p) => {
      const other = parsePromptKey(p.prompt_key)
      return (
        promptWaiting(p) &&
        other?.taskId === parsed.taskId &&
        other.number === parsed.number &&
        other.date !== parsed.date
      )
    })
    if (prompt) return { group, prompt }
  }
  return null
}
