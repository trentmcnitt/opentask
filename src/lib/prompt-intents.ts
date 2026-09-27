import type { QuotaPrompt } from '@/lib/quota-prompts'

/**
 * The pure halves of considering reminders and quota prompts on the web —
 * pulled out of `useReminders` so node tests can reach them
 * (tests/behavioral/prompt-intents.test.ts).
 */

/** What a prompt tap asked for: the circle, or the square checkbox. */
export type PromptIntent = 'consider' | 'did'

/**
 * A prompt after `intent`, and every sibling prompt of the same quota with the
 * count that implies — a did-it on "Piano Scales" in the morning moves the
 * afternoon's row to 1/2 too. The server's own answer replaces this on the
 * next refresh; this is only what the screen shows until then.
 *
 * Skips a prompt the payload already shows as considered: a refresh that
 * lands after the server committed but before the request returned must not
 * count the +1 twice.
 */
export function applyPromptIntents<G extends { prompts: QuotaPrompt[] }>(
  groups: G[],
  intents: Map<string, PromptIntent>,
): G[] {
  if (intents.size === 0) return groups
  const all = groups.flatMap((g) => g.prompts)
  const counts = new Map<number, number>()
  for (const p of all) {
    const intent = intents.get(p.prompt_key)
    if (!intent || p.considered) continue
    const current = counts.get(p.task_id) ?? p.current
    if (intent === 'did') {
      counts.set(p.task_id, p.number !== null ? Math.max(current, p.number) : current + 1)
    }
  }
  return groups.map((g) => {
    if (!g.prompts.some((p) => intents.has(p.prompt_key) || counts.has(p.task_id))) return g
    return {
      ...g,
      prompts: g.prompts.map((p) => {
        const intent = intents.get(p.prompt_key)
        const current = counts.get(p.task_id) ?? p.current
        const acted = intent !== undefined && !p.considered
        return {
          ...p,
          current,
          considered: p.considered || acted,
          done: (acted && intent === 'did') || (p.number !== null ? current >= p.number : p.done),
        }
      }),
    }
  })
}

/**
 * The narrowest request that commits a consideration. Reminders alone go
 * where they always went (/done, bulk/done); prompts alone to their own
 * endpoint; a mix to bulk/complete, so a slot's sweep is ONE undo entry.
 */
export function completionRequest(
  ids: number[],
  keys: string[],
  intent: PromptIntent,
): [string, RequestInit] {
  const post = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (keys.length === 0) {
    return ids.length === 1
      ? [`/api/tasks/${ids[0]}/done`, { method: 'POST' }]
      : ['/api/tasks/bulk/done', post({ ids })]
  }
  if (ids.length === 0) {
    return [`/api/quota-prompts/${intent === 'did' ? 'did' : 'consider'}`, post({ keys })]
  }
  return [
    '/api/tasks/bulk/complete',
    post({ ids, prompts: keys.map((key) => ({ key, did: intent === 'did' })) }),
  ]
}
