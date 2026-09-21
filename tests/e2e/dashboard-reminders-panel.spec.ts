/**
 * The dashboard's Reminders panel (above Track, right column at `xl`).
 *
 * Conventions borrowed from `dashboard-layout.spec.ts` (viewport handling,
 * quota creation/cleanup so `twoColumn` actually splits) and
 * `reminders.spec.ts` (seeding reminders via `page.request.post`, the
 * `todayAt` helper). This spec owns neither surface — it only covers the
 * compact panel itself: default slot, paging, the row cap, and completion.
 * The cap rule it pins: 9 rows wide, 5 narrow, the rest behind "Show more".
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

/** The seeded test user's timezone — slot assignment is done in local time. */
const TEST_TZ = 'America/Chicago'

/** Today at HH:MM in the user's timezone, as a UTC ISO string. */
function todayAt(hour: number, minute = 0): string {
  return DateTime.now()
    .setZone(TEST_TZ)
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO() as string
}

async function createReminder(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: { is_reminder: true, ...body } })
  expect(res.ok()).toBeTruthy()
  const json = await res.json()
  return json.data.id as number
}

async function createQuota(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: body })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function deleteTasks(page: Page, ids: number[]): Promise<void> {
  for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
}

interface TimeSlotDTO {
  id: number
  label: string
  start_time: string
}

async function fetchTimeSlots(page: Page): Promise<TimeSlotDTO[]> {
  const res = await page.request.get('/api/time-slots')
  expect(res.ok()).toBeTruthy()
  const json = await res.json()
  // Earliest first, same order `groups` puts them in (see groupBySlot).
  return (json.data.time_slots as TimeSlotDTO[])
    .slice()
    .sort((a, b) => a.start_time.localeCompare(b.start_time))
}

function parseHHMM(value: string): number {
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

/**
 * Mirrors `naturalSlotIndex` in `src/lib/time-slot-assign.ts`: the latest slot
 * whose start is at or before now, else the first slot. Duplicated here
 * (rather than imported) because Playwright specs run outside the app's `@/`
 * path aliasing — see the other spec files, none of which import app source.
 */
function naturalSlotIndex(slots: TimeSlotDTO[]): number {
  const now = DateTime.now().setZone(TEST_TZ)
  const minutes = now.hour * 60 + now.minute
  let best = -1
  let bestStart = -1
  slots.forEach((s, i) => {
    const start = parseHHMM(s.start_time)
    if (start > minutes) return
    if (start > bestStart) {
      bestStart = start
      best = i
    }
  })
  return best >= 0 ? best : 0
}

function panel(page: Page) {
  return page.locator('[data-reminders-panel]')
}

/** `formatSlotTime` in the app: "07:00" → "7:00 AM". */
function formatSlotTime(startTime: string): string {
  return DateTime.fromFormat(startTime, 'HH:mm').toFormat('h:mm a')
}

test.describe('Dashboard Reminders panel — wide', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('sits above Track in the right column and shows the natural slot by default', async ({
    authenticatedPage: page,
  }) => {
    const slots = await fetchTimeSlots(page)
    const naturalIndex = naturalSlotIndex(slots)
    const natural = slots[naturalIndex]
    // One minute after the slot's own boundary — safely inside its window
    // without landing on a boundary shared with the slot before it.
    const naturalStart = parseHHMM(natural.start_time) + 1

    const ids: number[] = []
    try {
      // A quota, so `twoColumn` actually splits into two columns (see
      // dashboard-layout.spec.ts) — without one the right column collapses
      // and this test would trivially "pass" with no second column at all.
      ids.push(
        await createQuota(page, {
          title: 'Reminders panel probe quota',
          progress_target: 2,
          rrule: 'FREQ=WEEKLY',
          create_label: true,
        }),
      )
      ids.push(
        await createReminder(page, {
          title: 'Reminders panel probe — natural slot',
          due_at: todayAt(Math.floor(naturalStart / 60), naturalStart % 60),
        }),
      )

      await page.goto('/')
      await expect(panel(page)).toBeVisible()
      await expect(page.locator('[data-track-panel]')).toBeVisible()

      // Above Track, in the SAME (right) column: same left edge, sitting
      // higher on the page, and to the right of the task list.
      const panelBox = await panel(page).boundingBox()
      const trackBox = await page.locator('[data-track-panel]').boundingBox()
      const filtersBox = await page.locator('main > div').first().boundingBox()
      if (!panelBox || !trackBox || !filtersBox) throw new Error('geometry not available')
      expect(Math.round(panelBox.x)).toBe(Math.round(trackBox.x))
      expect(panelBox.y).toBeLessThan(trackBox.y)
      expect(panelBox.x).toBeGreaterThanOrEqual(filtersBox.x + filtersBox.width)

      // The natural slot — the latest one at or before now — is what shows,
      // named the same way as the widget's own pager.
      await expect(panel(page)).toHaveAttribute('data-reminders-slot', String(natural.id))
      // The label is rendered in small caps via CSS (`uppercase`); its DOM text
      // content is the slot's own label, e.g. "Early morning".
      await expect(panel(page).getByText(natural.label, { exact: true })).toBeVisible()
      await expect(
        panel(page).getByText(formatSlotTime(natural.start_time), { exact: false }),
      ).toBeVisible()
      await expect(panel(page).getByText('Reminders panel probe — natural slot')).toBeVisible()
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('pages between slots and disables the chevrons at both ends, without wrapping', async ({
    authenticatedPage: page,
  }) => {
    const slots = await fetchTimeSlots(page)
    const naturalIndex = naturalSlotIndex(slots)

    const ids: number[] = []
    try {
      // One reminder anywhere keeps the panel from hiding itself (it hides
      // with nothing to show at all — see `hasAnything`).
      ids.push(await createReminder(page, { title: 'Keeps the panel alive', due_at: todayAt(7) }))

      await page.goto('/')
      await expect(panel(page)).toBeVisible()

      const prev = panel(page).getByRole('button', { name: 'Previous time slot' })
      const next = panel(page).getByRole('button', { name: 'Next time slot' })

      // Walk to the first slot and confirm the ends: no wraparound past it.
      for (let i = 0; i < naturalIndex; i++) await prev.click()
      await expect(panel(page)).toHaveAttribute('data-reminders-slot', String(slots[0].id))
      await expect(prev).toBeDisabled()
      await expect(next).toBeEnabled()

      // Walk all the way to the LAST group — the trailing "Anytime" bucket,
      // one past the real slots (`groups` always has `slots.length + 1`
      // entries; see `groupBySlot`) — and confirm the other end.
      for (let i = 0; i < slots.length; i++) await next.click()
      await expect(panel(page)).toHaveAttribute('data-reminders-slot', 'unslotted')
      await expect(next).toBeDisabled()
      await expect(prev).toBeEnabled()
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('caps a long slot at 9 rows, and "Show more" uncaps it with a considered readout', async ({
    authenticatedPage: page,
  }) => {
    const slots = await fetchTimeSlots(page)
    const naturalIndex = naturalSlotIndex(slots)
    const natural = slots[naturalIndex]
    const startMinutes = parseHHMM(natural.start_time)
    const at = (offset: number) =>
      todayAt(Math.floor((startMinutes + offset) / 60), (startMinutes + offset) % 60)

    // 15 — past the wide cap of 9, so 6 are held back at this viewport.
    // Completing one below still leaves 14, i.e. still capped.
    const titles = Array.from({ length: 15 }, (_, i) => `Cap probe reminder ${i}`)
    const ids: number[] = []
    try {
      for (let i = 0; i < titles.length; i++) {
        ids.push(await createReminder(page, { title: titles[i], due_at: at(i + 1) }))
      }

      await page.goto('/')
      await expect(panel(page)).toBeVisible()
      await expect(panel(page)).toHaveAttribute('data-reminders-slot', String(natural.id))

      // Capped: 9 of the 15 on screen, a "Show more" beneath them, and the
      // readout counting the whole slot (0 considered of 15).
      await expect(panel(page).locator('li[data-reminder-id]:visible')).toHaveCount(9)
      await expect(panel(page).getByText('of 15')).toBeVisible()
      const showMore = panel(page).getByRole('button', { name: /Show more/ })
      await expect(showMore).toBeVisible()
      await expect(showMore).toContainText('6 more')
      // No "Considered all" and no progress hint while capped.
      const considerAll = panel(page).getByRole('button', {
        name: /^Mark all in .+ as considered$/,
      })
      await expect(considerAll).toHaveCount(0)
      await expect(panel(page).getByRole('progressbar')).toHaveCount(0)

      await showMore.click()

      // Uncapped: all 15, the progress hint, and the quick action.
      await expect(panel(page).locator('li[data-reminder-id]:visible')).toHaveCount(15)
      await expect(panel(page).getByRole('button', { name: /Show less/ })).toBeVisible()
      await expect(panel(page).getByRole('progressbar')).toBeVisible()
      await expect(considerAll).toBeVisible()

      // A tap on a row's circle completes it and it leaves the panel; the
      // slot's total holds steady while the considered half of the count climbs.
      // Waited for explicitly (not just the optimistic UI update) so cleanup's
      // DELETE below can never race the completion's own POST server-side.
      const completion = page.waitForResponse((res) =>
        res.url().includes(`/api/tasks/${ids[0]}/done`),
      )
      await panel(page)
        .getByRole('button', { name: `Mark "${titles[0]}" as considered` })
        .click()
      await completion
      await expect(panel(page).getByText(titles[0])).toHaveCount(0)
      await expect(panel(page).locator('li[data-reminder-id]:visible')).toHaveCount(14)
      await expect(panel(page).getByText('of 15')).toBeVisible()

      // The toast's Undo proves the dashboard's OWN undo pipeline is wired to
      // this panel end to end (`handleUndo` → `refreshAll` →
      // `remindersRefreshRef.current?.()`) — a second, independent undo
      // pipeline here would be a real bug (see DashboardClient.tsx), and this
      // is the one thing that could not be seen from the row disappearing.
      await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
      await expect(panel(page).locator('li[data-reminder-id]:visible')).toHaveCount(15)
      await expect(panel(page).getByText(titles[0])).toBeVisible()

      // Show less returns to the 9-row cap (of the 15 again waiting).
      await panel(page).getByRole('button', { name: 'Show less' }).click()
      await expect(panel(page).locator('li[data-reminder-id]:visible')).toHaveCount(9)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('a slot inside the wide cap shows every row, with no toggle to press', async ({
    authenticatedPage: page,
  }) => {
    const slots = await fetchTimeSlots(page)
    const natural = slots[naturalSlotIndex(slots)]
    const startMinutes = parseHHMM(natural.start_time)
    const at = (offset: number) =>
      todayAt(Math.floor((startMinutes + offset) / 60), (startMinutes + offset) % 60)

    // 7 — under the wide cap of 9, so nothing is held back HERE. The phone
    // spec below seeds the same size and proves it IS capped at that width;
    // the pair is what pins the cap as per-width rather than absolute.
    const titles = Array.from({ length: 7 }, (_, i) => `Wide cap probe ${i}`)
    const ids: number[] = []
    try {
      for (let i = 0; i < titles.length; i++) {
        ids.push(await createReminder(page, { title: titles[i], due_at: at(i + 1) }))
      }

      await page.goto('/')
      await expect(panel(page)).toBeVisible()

      await expect(panel(page).locator('li[data-reminder-id]:visible')).toHaveCount(7)
      await expect(panel(page).getByRole('button', { name: /Show more/ })).toBeHidden()
      await expect(panel(page).getByRole('button', { name: /Show less/ })).toHaveCount(0)
    } finally {
      await deleteTasks(page, ids)
    }
  })
})

/**
 * Press-and-hold on a row: a separate describe from the cap/paging suite
 * above so this file's per-describe line count stays under ESLint's
 * `max-lines-per-function` rather than growing that one further.
 */
test.describe('Dashboard Reminders panel — press and hold', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  /**
   * Press-and-hold opens the row's read-only bubble, and the bubble's Open
   * reaches the same editor `/reminders` uses (Trent,
   * 2026-09-21: "whenever I do things with tasks it opens a modal... that's
   * how I like to work"), for that ONE reminder. The circle is "complete this
   * reminder" on a plain tap, so this pins the thing that must NOT happen: a
   * hold that starts anywhere on the row — including, implicitly, near the
   * circle — must never also fire the completion it takes to open the modal.
   */
  test('press-and-hold opens the row\u2019s bubble, whose Open reaches the editor', async ({
    authenticatedPage: page,
  }) => {
    const slots = await fetchTimeSlots(page)
    const naturalIndex = naturalSlotIndex(slots)
    const natural = slots[naturalIndex]
    const naturalStart = parseHHMM(natural.start_time) + 1
    const title = 'Reminders panel hold-to-edit probe'
    // A note, because reading one from the dashboard is the whole reason the
    // bubble exists — a panel row is one clamped line with no note indicator.
    const notes = 'Only reachable from the bubble, not from the row.'

    const ids: number[] = []
    try {
      ids.push(
        await createReminder(page, {
          title,
          notes,
          due_at: todayAt(Math.floor(naturalStart / 60), naturalStart % 60),
        }),
      )
      const id = ids[0]

      await page.goto('/')
      await expect(panel(page)).toBeVisible()
      await expect(panel(page).getByText(title)).toBeVisible()
      // The note is NOT on the row itself.
      await expect(panel(page).getByText(notes)).toHaveCount(0)

      let doneRequests = 0
      page.on('request', (r) => {
        if (r.method() === 'POST' && r.url().endsWith(`/api/tasks/${id}/done`)) doneRequests++
      })

      // The title text, not the row's centre: the circle sits to its left,
      // and a click there would be testing the wrong control.
      await panel(page).getByText(title).click({ delay: 500 })

      // A hold opens the READ-ONLY bubble, not the editor — and the note is
      // legible there without opening anything further.
      const bubble = page.locator(`[data-reminder-popover="${id}"]`)
      await expect(bubble).toBeVisible()
      await expect(bubble.getByText(notes)).toBeVisible()
      await expect(page.locator(`[data-reminder-detail="${id}"]`)).toHaveCount(0)
      expect(doneRequests).toBe(0)

      // Open is the second step, and only it reaches the editor.
      await bubble.getByRole('button', { name: 'Open' }).click()
      const editor = page
        .getByRole('dialog')
        .filter({ has: page.locator('[data-reminder-detail]') })
      await expect(editor).toBeVisible()
      await expect(page.locator(`[data-reminder-detail="${id}"]`)).toBeVisible()
      expect(doneRequests).toBe(0)

      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)

      // Still there, still waiting — the hold neither completed it nor left
      // it in some half-edited state.
      await expect(panel(page).getByText(title)).toBeVisible()
      expect(doneRequests).toBe(0)
      const after = await (await page.request.get(`/api/tasks/${id}`)).json()
      expect(after.data.done).toBe(false)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('deletes a reminder from its row’s editor, with an Undo', async ({
    authenticatedPage: page,
  }) => {
    const slots = await fetchTimeSlots(page)
    const naturalIndex = naturalSlotIndex(slots)
    const natural = slots[naturalIndex]
    const naturalStart = parseHHMM(natural.start_time) + 1
    const title = 'Reminders panel hold-to-delete probe'

    const ids: number[] = []
    try {
      ids.push(
        await createReminder(page, {
          title,
          due_at: todayAt(Math.floor(naturalStart / 60), naturalStart % 60),
        }),
      )
      const id = ids[0]

      await page.goto('/')
      await expect(panel(page)).toBeVisible()
      await panel(page).getByText(title).click({ delay: 500 })
      await page
        .locator(`[data-reminder-popover="${id}"]`)
        .getByRole('button', { name: 'Open' })
        .click()

      const editor = page
        .getByRole('dialog')
        .filter({ has: page.locator('[data-reminder-detail]') })
      await expect(editor).toBeVisible()
      await expect(page.locator(`[data-reminder-detail="${id}"]`)).toBeVisible()

      const deleted = page.waitForResponse(
        (r) => r.url().includes('/api/tasks/bulk/delete') && r.request().method() === 'POST',
      )
      await editor.getByRole('button', { name: 'Move to Trash' }).click()
      expect((await deleted).status()).toBe(200)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(panel(page).getByText(title)).toHaveCount(0)

      // The same Undo every soft delete offers.
      await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
      await expect(panel(page).getByText(title)).toBeVisible()
    } finally {
      await deleteTasks(page, ids)
    }
  })
})

test.describe('Dashboard Reminders panel — phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('caps a slot at 5 rows on a phone, where 7 would fit on a desktop', async ({
    authenticatedPage: page,
  }) => {
    const slots = await fetchTimeSlots(page)
    const natural = slots[naturalSlotIndex(slots)]
    const startMinutes = parseHHMM(natural.start_time)
    const at = (offset: number) =>
      todayAt(Math.floor((startMinutes + offset) / 60), (startMinutes + offset) % 60)

    // The SAME 7 the wide spec above shows in full. The cap is per-width —
    // narrow is where this panel shares vertical space with the day, so it
    // holds two back and offers the button the wide layout does not need.
    const titles = Array.from({ length: 7 }, (_, i) => `Phone cap probe ${i}`)
    const ids: number[] = []
    try {
      for (let i = 0; i < titles.length; i++) {
        ids.push(await createReminder(page, { title: titles[i], due_at: at(i + 1) }))
      }

      await page.goto('/')
      await expect(panel(page)).toBeVisible()

      await expect(panel(page).locator('li[data-reminder-id]:visible')).toHaveCount(5)
      const showMore = panel(page).getByRole('button', { name: /Show more/ })
      await expect(showMore).toBeVisible()
      await expect(showMore).toContainText('2 more')

      await showMore.click()
      await expect(panel(page).locator('li[data-reminder-id]:visible')).toHaveCount(7)
      await expect(panel(page).getByRole('button', { name: 'Show less' })).toBeVisible()
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('appears inline above Track, not in a second column', async ({
    authenticatedPage: page,
  }) => {
    const slots = await fetchTimeSlots(page)
    const natural = slots[naturalSlotIndex(slots)]
    const naturalStart = parseHHMM(natural.start_time) + 1

    const ids: number[] = []
    try {
      // Seeded into the NATURAL slot specifically (not just "today at 7am"):
      // the panel only shows its current page, so a reminder placed in a slot
      // that is not showing would never be found by the text assertion below.
      ids.push(
        await createReminder(page, {
          title: 'Phone panel probe',
          due_at: todayAt(Math.floor(naturalStart / 60), naturalStart % 60),
        }),
      )
      ids.push(
        await createQuota(page, {
          title: 'Reminders phone probe quota',
          progress_target: 2,
          rrule: 'FREQ=WEEKLY',
          create_label: true,
        }),
      )

      await page.goto('/')
      await expect(panel(page)).toBeVisible()

      const panelBox = await panel(page).boundingBox()
      const filtersBox = await page.locator('main > div').first().boundingBox()
      const sectionToggle = page.locator('[data-track-section-toggle]')
      const trackToggleBox = await sectionToggle.boundingBox()
      if (!panelBox || !filtersBox || !trackToggleBox) throw new Error('geometry not available')

      // Single column: the panel shares the filters' left edge (no second
      // grid column at this width — see `mainClass` in DashboardClient.tsx).
      expect(Math.round(panelBox.x)).toBe(Math.round(filtersBox.x))
      // Still above Track, same as at `xl`.
      expect(panelBox.y).toBeLessThan(trackToggleBox.y)

      await expect(panel(page).getByText('Phone panel probe')).toBeVisible()
    } finally {
      await deleteTasks(page, ids)
    }
  })
})
