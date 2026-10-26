/**
 * Priority Display (`src/lib/priority-display.ts`): the one rule every row —
 * task rows, reminder rows, quota prompt rows and quota chips — reads the
 * user's Settings → Priority Display through. Each option turns on exactly
 * its own part; None shows nothing; the indicator (the priority tab) is High
 * and Urgent only, as on the task rows' corner.
 */
import { describe, test, expect } from 'vitest'
import { getPriorityColors, priorityRowStyles } from '@/lib/priority-display'
import type { PriorityDisplayConfig } from '@/types'

const OFF: PriorityDisplayConfig = {
  trailingDot: false,
  badgeStyle: 'words',
  colorTitle: false,
  rightBorder: false,
  colorCheckbox: false,
}

const NOTHING = { tab: null, title: null, border: null, bar: null, check: null }

describe('priority display: the shared row rule', () => {
  test('every option off: nothing at any priority', () => {
    for (const p of [0, 1, 2, 3, 4]) expect(priorityRowStyles(p, OFF)).toEqual(NOTHING)
  })

  test('every option on: None still shows nothing', () => {
    const all: PriorityDisplayConfig = {
      trailingDot: true,
      badgeStyle: 'words',
      colorTitle: true,
      rightBorder: true,
      colorCheckbox: true,
    }
    expect(priorityRowStyles(0, all)).toEqual(NOTHING)
  })

  test('the indicator: a tab for High and Urgent only, in the chosen style', () => {
    const on = { ...OFF, trailingDot: true }
    expect(priorityRowStyles(1, on).tab).toBeNull()
    expect(priorityRowStyles(2, on).tab).toBeNull()
    expect(priorityRowStyles(3, on).tab).toMatchObject({ text: 'High' })
    expect(priorityRowStyles(4, on).tab).toMatchObject({ text: 'Urgent' })
    const icons = { ...on, badgeStyle: 'icons' as const }
    expect(priorityRowStyles(3, icons).tab?.text).toBe('!')
    expect(priorityRowStyles(4, icons).tab?.text).toBe('!!')
    // The indicator turns on nothing else.
    expect(priorityRowStyles(4, on)).toMatchObject({
      title: null,
      border: null,
      bar: null,
      check: null,
    })
  })

  test('colour titles: Low to Urgent, nothing else', () => {
    const on = { ...OFF, colorTitle: true }
    expect(priorityRowStyles(1, on).title).toBe('text-zinc-400')
    expect(priorityRowStyles(2, on).title).toBe('text-amber-500')
    expect(priorityRowStyles(3, on).title).toBe('text-orange-500')
    expect(priorityRowStyles(4, on).title).toBe('text-red-500')
    expect(priorityRowStyles(2, on)).toMatchObject({
      tab: null,
      border: null,
      bar: null,
      check: null,
    })
  })

  test('right border: the border and bar colours, Low to Urgent, nothing else', () => {
    const on = { ...OFF, rightBorder: true }
    expect(priorityRowStyles(1, on).border).toBe('border-r-zinc-400/50')
    expect(priorityRowStyles(2, on).border).toBe('border-r-amber-500/50')
    expect(priorityRowStyles(4, on).border).toBe('border-r-red-500/50')
    // The bar (rows with no border of their own): the same colour as a fill.
    expect(priorityRowStyles(2, on).bar).toBe('bg-amber-500/50')
    expect(priorityRowStyles(4, on).bar).toBe('bg-red-500/50')
    expect(priorityRowStyles(2, on)).toMatchObject({ tab: null, title: null, check: null })
  })

  test('colour checkbox: the full colour set, Low to Urgent, nothing else', () => {
    const on = { ...OFF, colorCheckbox: true }
    expect(priorityRowStyles(2, on).check).toBe(getPriorityColors(2))
    expect(priorityRowStyles(3, on).check?.checkbox).toBe('border-orange-400/50')
    expect(priorityRowStyles(2, on)).toMatchObject({
      tab: null,
      title: null,
      border: null,
      bar: null,
    })
  })

  test('colours exist for 1–4 only', () => {
    expect(getPriorityColors(0)).toBeNull()
    expect(getPriorityColors(5)).toBeNull()
    for (const p of [1, 2, 3, 4]) {
      const c = getPriorityColors(p)!
      // A currentColor ring (the quota prompt's dashed circle) and a border
      // circle (task / reminder rows) both have their own classes.
      expect(c.ring).toMatch(/^text-/)
      expect(c.checkbox).toMatch(/^border-/)
      expect(c.checkIcon).toMatch(/^group-hover\/done:text-/)
    }
  })
})
