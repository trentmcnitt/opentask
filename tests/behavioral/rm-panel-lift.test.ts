/**
 * RM-L: NOTIFICATION TAPS LAND ON THE DASHBOARD (Trent, 2026-11-09;
 * src/lib/panel-lift.ts). The Reminders card pages to the item's period and
 * lifts a reminder or quota prompt to the top of it; a period push only pages.
 */
import { describe, expect, test } from 'vitest'
import {
  liftFirst,
  liftFromParams,
  liftPageIndex,
  liftedId,
  resolvePromptKey,
} from '@/lib/panel-lift'

type Prompt = { prompt_key: string; waiting: boolean }
const page = (key: string, reminders: number[], prompts: Prompt[] = []) => ({
  key,
  group: { reminders: reminders.map((id) => ({ id })), prompts },
})
const isWaiting = (p: Prompt) => p.waiting

describe('RM-L01 the links', () => {
  test('?reminder=, ?prompt= and ?slot= each ask for a lift; anything else does not', () => {
    const lift = (q: string) => liftFromParams(new URLSearchParams(q))
    expect(lift('reminder=42')).toEqual({ kind: 'reminder', id: 42 })
    expect(lift('prompt=q%3A9%3A2%3A2026-11-09')).toEqual({
      kind: 'prompt',
      key: 'q:9:2:2026-11-09',
    })
    expect(lift('slot=7')).toEqual({ kind: 'slot', slotKey: '7' })
    expect(lift('slot=unslotted')).toEqual({ kind: 'slot', slotKey: 'unslotted' })
    // A redirected `/reminders?reminder=<id>&select=1` still lifts.
    expect(lift('reminder=42&select=1')).toEqual({ kind: 'reminder', id: 42 })
    expect(lift('reminder=abc')).toBeNull()
    expect(lift('slot=morning')).toBeNull()
    expect(lift('task=42')).toBeNull()
    expect(lift('')).toBeNull()
  })
})

describe('RM-L02 the page', () => {
  const pages = [
    page('3', [1, 2]),
    page('7', [10, 11, 12], [{ prompt_key: 'q:9:2:d', waiting: true }]),
    page('unslotted', [20], [{ prompt_key: 'q:9:1:d', waiting: false }]),
  ]
  test('a reminder and a waiting prompt go to the period that holds them; a slot to its key', () => {
    expect(liftPageIndex(pages, { kind: 'reminder', id: 11 }, isWaiting)).toBe(1)
    expect(liftPageIndex(pages, { kind: 'prompt', key: 'q:9:2:d' }, isWaiting)).toBe(1)
    expect(liftPageIndex(pages, { kind: 'slot', slotKey: 'unslotted' }, isWaiting)).toBe(2)
  })
  test('a prompt no longer waiting, an unknown id or slot: no page', () => {
    expect(liftPageIndex(pages, { kind: 'prompt', key: 'q:9:1:d' }, isWaiting)).toBe(-1)
    expect(liftPageIndex(pages, { kind: 'reminder', id: 99 }, isWaiting)).toBe(-1)
    expect(liftPageIndex(pages, { kind: 'slot', slotKey: '99' }, isWaiting)).toBe(-1)
  })
})

describe('RM-L03 the lifted row is first, the rest keep their order', () => {
  const r = (id: number) => ({ kind: 'reminder' as const, reminder: { id } })
  const p = (key: string) => ({ kind: 'prompt' as const, prompt: { prompt_key: key } })
  const rows = [r(1), r(2), r(3), p('q:9:2:d')]
  test('a reminder past the fold, and a prompt after the reminders', () => {
    expect(liftFirst(rows, 3)).toEqual([r(3), r(1), r(2), p('q:9:2:d')])
    expect(liftFirst(rows, 'q:9:2:d')).toEqual([p('q:9:2:d'), r(1), r(2), r(3)])
  })
  test('already first, gone, or no lift: unchanged', () => {
    expect(liftFirst(rows, 1)).toBe(rows)
    expect(liftFirst(rows, 99)).toBe(rows)
    expect(liftFirst(rows, null)).toBe(rows)
  })
  test('a slot lift names no row', () => {
    expect(liftedId({ kind: 'slot', slotKey: '7' })).toBeNull()
    expect(liftedId({ kind: 'reminder', id: 3 })).toBe(3)
    expect(liftedId({ kind: 'prompt', key: 'k' })).toBe('k')
    expect(liftedId(null)).toBeNull()
  })
})

describe('RM-L04 a prompt key from another day names today’s row', () => {
  const groups = [
    { prompts: [{ prompt_key: 'q:9:1:2026-11-09', waiting: false }] },
    { prompts: [{ prompt_key: 'q:9:2:2026-11-09', waiting: true }] },
  ]
  test('the exact key, waiting or handled, is itself', () => {
    expect(resolvePromptKey(groups, 'q:9:2:2026-11-09', isWaiting)).toBe('q:9:2:2026-11-09')
    expect(resolvePromptKey(groups, 'q:9:1:2026-11-09', isWaiting)).toBe('q:9:1:2026-11-09')
  })
  test('yesterday’s key: today’s waiting row of the same quota and number, else nothing', () => {
    // A widget last drawn before midnight.
    expect(resolvePromptKey(groups, 'q:9:2:2026-11-08', isWaiting)).toBe('q:9:2:2026-11-09')
    // Today's row for number 1 is handled: no waiting row to name.
    expect(resolvePromptKey(groups, 'q:9:1:2026-11-08', isWaiting)).toBeNull()
    expect(resolvePromptKey(groups, 'q:7:2:2026-11-08', isWaiting)).toBeNull()
    expect(resolvePromptKey(groups, 'not-a-key', isWaiting)).toBeNull()
  })
})
