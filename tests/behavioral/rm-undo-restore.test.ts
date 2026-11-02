/**
 * Undo on the Reminders surface puts a consider's rows back at once
 * (2026-10-29, `src/lib/reminder-undo.ts`): where they were, and pinned there
 * until a payload from after the undo lands.
 */
import { describe, expect, test } from 'vitest'
import { PinnedUndone, SettlingConsiders, restoreInPlace } from '@/lib/reminder-undo'
import type { ReminderGroup } from '@/hooks/useReminders'
import type { QuotaPrompt } from '@/lib/quota-prompts'
import type { Task } from '@/types'

const task = (id: number) => ({ id, title: `Thought ${id}` }) as Task
const prompt = (key: string, considered = false) =>
  ({ prompt_key: key, considered, done: false }) as QuotaPrompt
const group = (waiting: number[], considered: number[], prompts: QuotaPrompt[] = []) =>
  ({
    slot: null,
    reminders: waiting.map(task),
    count: waiting.length,
    consideredItems: considered.map(task),
    considered: considered.length,
    prompts,
  }) as ReminderGroup

describe('restoreInPlace', () => {
  test('RU-01: a considered row goes back to its place in the slot, not the end', () => {
    const before = [group([1, 2, 3], [])]
    const after = [group([1, 3], [2])]
    const restored = restoreInPlace(after, before, new Set([2]), new Set())
    expect(restored[0].reminders.map((r) => r.id)).toEqual([1, 2, 3])
    expect(restored[0].consideredItems).toEqual([])
    expect(restored[0].count).toBe(3)
    expect(restored[0].considered).toBe(0)
  })

  test('RU-02: a row still collapsing (never left `reminders`) stays where it is', () => {
    const before = [group([1, 2], [])]
    const restored = restoreInPlace(before, before, new Set([2]), new Set())
    expect(restored[0].reminders.map((r) => r.id)).toEqual([1, 2])
  })

  test('RU-03: a handled prompt waits again', () => {
    const before = [group([], [], [prompt('q:1', false)])]
    const after = [group([], [], [prompt('q:1', true)])]
    const restored = restoreInPlace(after, before, new Set(), new Set(['q:1']))
    expect(restored[0].prompts[0].considered).toBe(false)
  })

  test('RU-04: other groups and rows are untouched', () => {
    const other = group([7], [8])
    const restored = restoreInPlace([other], [other], new Set([2]), new Set())
    expect(restored[0]).toBe(other)
  })
})

describe('PinnedUndone', () => {
  test('RU-10: pinned until confirmed, then until a payload from after the undo', () => {
    const pinned = new PinnedUndone()
    pinned.pin([2, 'q:1'])
    expect(pinned.ids()).toEqual(new Set([2]))
    expect(pinned.keys()).toEqual(new Set(['q:1']))
    // A payload landing before the undo's answer: still pinned.
    pinned.settle(5)
    expect(pinned.ids()).toEqual(new Set([2]))
    // The undo answered while request 5 was the latest: request 6 includes it.
    pinned.confirm([2, 'q:1'], 6)
    pinned.settle(5)
    expect(pinned.ids()).toEqual(new Set([2]))
    pinned.settle(6)
    expect(pinned.ids()).toEqual(new Set())
    expect(pinned.keys()).toEqual(new Set())
  })

  test('RU-11: unconfirmed lists what still waits for an answer; release drops it', () => {
    const pinned = new PinnedUndone()
    pinned.pin([1, 2])
    pinned.confirm([1], 3)
    expect(pinned.unconfirmed([1, 2])).toEqual([2])
    pinned.release([2])
    expect(pinned.unconfirmed([1, 2])).toEqual([])
    expect(pinned.ids()).toEqual(new Set([1]))
  })
})

/**
 * A consider that ANSWERED stays drawn considered until a payload requested
 * after the answer is applied (2026-11-02): a refresh sent at load and landing
 * after a burst of taps put the first considered row back, and the next tap
 * hit it — a second `/done` for one reminder.
 */
describe('SettlingConsiders', () => {
  test('RU-20: a payload requested before the answer leaves it considered; one after settles it', () => {
    const settling = new SettlingConsiders()
    // Request 3 was out when the consider answered: from request 4 on, it is in.
    settling.add([50, 'q:1'], 'consider', 4)
    expect(settling.ids()).toEqual(new Set([50]))
    expect(settling.prompts()).toEqual(new Map([['q:1', 'consider']]))
    settling.settle(3)
    expect(settling.ids()).toEqual(new Set([50]))
    settling.settle(4)
    expect(settling.ids()).toEqual(new Set())
    expect(settling.prompts()).toEqual(new Map())
  })

  test('RU-21: each entry settles on its own mark; release takes one back (undo, put back)', () => {
    const settling = new SettlingConsiders()
    settling.add([1], 'consider', 4)
    settling.add([2, 'q:2'], 'did', 6)
    settling.settle(5)
    expect(settling.ids()).toEqual(new Set([2]))
    expect(settling.prompts()).toEqual(new Map([['q:2', 'did']]))
    settling.release([2])
    expect(settling.ids()).toEqual(new Set())
    expect(settling.prompts()).toEqual(new Map([['q:2', 'did']]))
  })
})
