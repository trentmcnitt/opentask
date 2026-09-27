/**
 * Prompt intents and completion routing (WP3) — the pure halves of
 * considering reminders and quota prompts on the web, from
 * src/lib/prompt-intents.ts (formerly private to useReminders).
 */

import { describe, test, expect } from 'vitest'
import { applyPromptIntents, completionRequest, type PromptIntent } from '@/lib/prompt-intents'
import type { QuotaPrompt } from '@/lib/quota-prompts'

function prompt(overrides: Partial<QuotaPrompt> & { prompt_key: string }): QuotaPrompt {
  return {
    task_id: 1,
    number: null,
    numbers: null,
    slot_id: null,
    title: 'Sample quota',
    current: 0,
    target: 1,
    period: null,
    stripe_color: null,
    has_notes: false,
    considered: false,
    done: false,
    ...overrides,
  }
}

const intents = (entries: [string, PromptIntent][]) => new Map(entries)

// A daily quota with target 2 split across two periods: #1 in the morning,
// #2 in the afternoon. A second, weekly quota sits in the morning too.
function dailyGroups() {
  return [
    {
      name: 'morning',
      prompts: [
        prompt({ prompt_key: 'q:1:1', task_id: 1, number: 1, numbers: [1], target: 2 }),
        prompt({ prompt_key: 'q:2:1', task_id: 2, target: 3, current: 1 }),
      ],
    },
    {
      name: 'afternoon',
      prompts: [prompt({ prompt_key: 'q:1:2', task_id: 1, number: 2, numbers: [2], target: 2 })],
    },
  ]
}

describe('applyPromptIntents', () => {
  test('no intents returns the same groups object', () => {
    const groups = dailyGroups()
    expect(applyPromptIntents(groups, new Map())).toBe(groups)
  })

  test('did on a daily row re-counts its siblings in other periods', () => {
    const out = applyPromptIntents(dailyGroups(), intents([['q:1:1', 'did']]))
    const morning = out[0].prompts.find((p) => p.prompt_key === 'q:1:1')!
    const afternoon = out[1].prompts[0]
    expect(morning).toMatchObject({ current: 1, considered: true, done: true })
    // The sibling moves to 1/2 but is neither considered nor done.
    expect(afternoon).toMatchObject({ current: 1, considered: false, done: false })
  })

  test('did on the last daily number marks the sibling done too', () => {
    const out = applyPromptIntents(dailyGroups(), intents([['q:1:2', 'did']]))
    expect(out[1].prompts[0]).toMatchObject({ current: 2, considered: true, done: true })
    // The morning row's number (1) is now reached — done, but not considered.
    expect(out[0].prompts[0]).toMatchObject({ current: 2, considered: false, done: true })
  })

  test('did on a non-daily quota adds one', () => {
    const out = applyPromptIntents(dailyGroups(), intents([['q:2:1', 'did']]))
    expect(out[0].prompts[1]).toMatchObject({ current: 2, considered: true, done: true })
  })

  test('consider never changes a count', () => {
    const out = applyPromptIntents(
      dailyGroups(),
      intents([
        ['q:1:1', 'consider'],
        ['q:2:1', 'consider'],
      ]),
    )
    expect(out[0].prompts[0]).toMatchObject({ current: 0, considered: true, done: false })
    expect(out[0].prompts[1]).toMatchObject({ current: 1, considered: true, done: false })
    expect(out[1].prompts[0]).toMatchObject({ current: 0, considered: false })
  })

  test('skips a prompt the payload already shows as considered (no double +1)', () => {
    const groups = dailyGroups()
    // The server committed the did-it and a refresh landed before the request returned.
    groups[0].prompts[1] = { ...groups[0].prompts[1], current: 2, considered: true, done: true }
    const out = applyPromptIntents(groups, intents([['q:2:1', 'did']]))
    expect(out[0].prompts[1]).toMatchObject({ current: 2, considered: true, done: true })
  })

  test('leaves untouched groups as the same object', () => {
    const groups = [
      ...dailyGroups(),
      { name: 'evening', prompts: [prompt({ prompt_key: 'q:9:1', task_id: 9 })] },
    ]
    const out = applyPromptIntents(groups, intents([['q:2:1', 'consider']]))
    expect(out[2]).toBe(groups[2])
  })
})

describe('completionRequest', () => {
  const body = (init: RequestInit) => JSON.parse(init.body as string)

  test('one reminder → POST /api/tasks/:id/done', () => {
    const [url, init] = completionRequest([7], [], 'consider')
    expect(url).toBe('/api/tasks/7/done')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
  })

  test('several reminders → bulk/done', () => {
    const [url, init] = completionRequest([7, 8], [], 'consider')
    expect(url).toBe('/api/tasks/bulk/done')
    expect(body(init)).toEqual({ ids: [7, 8] })
  })

  test('prompts only → /quota-prompts/consider or /did', () => {
    const [considerUrl, considerInit] = completionRequest([], ['q:1:1'], 'consider')
    expect(considerUrl).toBe('/api/quota-prompts/consider')
    expect(body(considerInit)).toEqual({ keys: ['q:1:1'] })
    const [didUrl] = completionRequest([], ['q:1:1'], 'did')
    expect(didUrl).toBe('/api/quota-prompts/did')
  })

  test('a mix → bulk/complete, one request, did flag passed through', () => {
    const [url, init] = completionRequest([7], ['q:1:1', 'q:2:1'], 'did')
    expect(url).toBe('/api/tasks/bulk/complete')
    expect(body(init)).toEqual({
      ids: [7],
      prompts: [
        { key: 'q:1:1', did: true },
        { key: 'q:2:1', did: true },
      ],
    })
    const [, considered] = completionRequest([7], ['q:1:1'], 'consider')
    expect(body(considered).prompts).toEqual([{ key: 'q:1:1', did: false }])
  })
})
