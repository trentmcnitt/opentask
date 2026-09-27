/**
 * Quota reminders on the Reminders surface (2026-09-24)
 *
 * An unmet quota also shows up as a prompt in a reminder period. The
 * behavioral suite (qp-prompts.test.ts) pins which prompts a day has; these
 * tests cover what only a browser shows: the row, its two actions (the dashed
 * circle considers, the square checkbox logs one), the Undo, the quota editor's
 * "Remind me daily" switch, and the Settings switch.
 *
 * Time-agnostic: prompts render in every slot, started or not (a slot ahead
 * in the day still lists its prompts), so nothing here depends on the clock.
 * Every quota made here is trashed again afterwards, and the Settings switch
 * is put back, so other specs' counts are untouched.
 */

import {
  test,
  expect,
  waitForPreferenceSave,
  gotoQuotasDetails,
  uniqueTitle,
  waitForGetsSettled,
} from './fixtures'
import type { Page, Request } from '@playwright/test'
import { DateTime } from 'luxon'

/** The seeded user's timezone — must track globalSetup.ts's `E2E_TZ`. */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

const created: number[] = []

async function makeQuota(page: Page, title: string, rrule = 'FREQ=WEEKLY', target = 3) {
  const res = await page.request.post('/api/tasks', {
    data: { title, rrule, progress_target: target, is_tracked: true },
  })
  expect(res.ok()).toBeTruthy()
  const id = (await res.json()).data.id as number
  created.push(id)
  return id
}

async function progressOf(page: Page, id: number): Promise<number> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data.progress_current as number
}

function promptRow(page: Page, title: string) {
  return page.locator('li[data-prompt-key]', { hasText: title })
}

/** A prompt row inside one period's card. */
function promptIn(page: Page, slotLabel: string, title: string) {
  return page.locator(`[data-slot-group="${slotLabel}"] li[data-prompt-key]`, { hasText: title })
}

/**
 * Press and hold a prompt row until its bubble opens — the only way in, on
 * desktop too (right-click is left alone: on a quota chip it means −1).
 */
async function holdOpen(page: Page, row: ReturnType<typeof promptRow>) {
  const box = (await row.boundingBox())!
  await page.mouse.move(box.x + Math.min(120, box.width / 2), box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForSelector('[data-track-popover]')
  await page.mouse.up()
  return page.locator('[data-track-popover]')
}

async function userSlots(page: Page): Promise<{ id: number; label: string; start_time: string }[]> {
  const res = await page.request.get('/api/time-slots')
  const slots = (await res.json()).data.time_slots as {
    id: number
    label: string
    start_time: string
  }[]
  return [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time))
}

function isQuotaPatch(r: { request(): { method(): string }; url(): string }) {
  return r.request().method() === 'PATCH' && /\/api\/tasks\/\d+$/.test(r.url())
}

async function cleanUp(page: Page) {
  if (created.length > 0) {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: [...created] } })
    created.length = 0
  }
  await page.request.patch('/api/user/preferences', { data: { quota_prompts_enabled: true } })
}

test.describe('Quota prompts', () => {
  test.afterEach(async ({ authenticatedPage: page }) => cleanUp(page))

  test('the circle considers a prompt without logging, and the header Undo brings it back', async ({
    authenticatedPage: page,
  }) => {
    const id = await makeQuota(page, 'E2E prompt consider')
    await page.goto('/reminders')
    const row = promptRow(page, 'E2E prompt consider')
    await expect(row).toBeVisible()
    await expect(row).toContainText('0/3 this week')
    // A dashed circle, not the reminder's solid one: on a prompt it means
    // "seen", not "done".
    await expect(row.locator('[data-prompt-consider] svg[data-dashed-ring]')).toBeVisible()
    // Both of the row's controls wear the pointing hand.
    await expect(row.locator('[data-prompt-consider]')).toHaveCSS('cursor', 'pointer')
    await expect(row.locator('[data-prompt-did]')).toHaveCSS('cursor', 'pointer')

    // The row leaves optimistically, before the request lands: wait for the
    // consider itself, or `progressOf` can read the server before it has
    // done anything and pass whatever the consider does to the count.
    const key = await row.getAttribute('data-prompt-key')
    const considered = page.waitForResponse((r) => r.url().includes('/api/quota-prompts/consider'))
    await row.locator('[data-prompt-consider]').click()
    const res = await considered
    expect(res.ok()).toBeTruthy()
    expect(res.request().postDataJSON()).toEqual({ keys: [key] })
    await expect(row).toHaveCount(0)
    expect(await progressOf(page, id)).toBe(0)

    const undone = page.waitForResponse((r) => r.url().includes('/api/undo'))
    await page.getByRole('banner').getByRole('button', { name: /^Undo/ }).click()
    await undone
    await expect(promptRow(page, 'E2E prompt consider')).toBeVisible()
  })

  test('the square checkbox logs one, and the toast Undo takes it back', async ({
    authenticatedPage: page,
  }) => {
    const id = await makeQuota(page, 'E2E prompt did')
    await page.goto('/reminders')
    const row = promptRow(page, 'E2E prompt did')
    await expect(row).toBeVisible()

    const did = page.waitForResponse((r) => r.url().includes('/api/quota-prompts/did'))
    await row.locator('[data-prompt-did]').click()
    expect((await did).ok()).toBeTruthy()
    await expect(row).toHaveCount(0)
    expect(await progressOf(page, id)).toBe(1)

    const undone = page.waitForResponse((r) => r.url().includes('/api/undo'))
    await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
    await undone
    await expect(promptRow(page, 'E2E prompt did')).toBeVisible()
    await expect(promptRow(page, 'E2E prompt did')).toContainText('0/3 this week')
    expect(await progressOf(page, id)).toBe(0)
  })

  test("a prompt's hold opens its quota's bubble, whose switch turns it off", async ({
    authenticatedPage: page,
  }) => {
    await makeQuota(page, 'E2E prompt editor')
    await page.goto('/reminders')
    const row = promptRow(page, 'E2E prompt editor')
    await expect(row).toBeVisible()

    // Press and hold: the quota's bubble — on a prompt the hold never selects.
    const box = (await row.boundingBox())!
    await page.mouse.move(box.x + 120, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForSelector('[data-track-popover]')
    await page.mouse.up()
    await expect(page.getByRole('button', { name: /move .* to trash/i })).toHaveCount(1)
    await page.locator('[data-track-popover]').getByRole('button', { name: 'Open' }).click()

    const field = page.locator('[data-quota-prompt-field]')
    await expect(field).toBeVisible()
    await field.locator('[data-quota-prompt-enabled]').click()
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && /\/api\/tasks\/\d+$/.test(r.url()),
    )
    await page.getByRole('button', { name: 'Save' }).click()
    const body = await (await saved).json()
    expect(body.data.quota_prompt_config).toEqual({ enabled: false })
    await expect(promptRow(page, 'E2E prompt editor')).toHaveCount(0)
  })

  test("the count names its period, in the Quotas panel's words — on the dashboard card too", async ({
    authenticatedPage: page,
  }) => {
    // Two periods, two phrasings. A quota always has a period now — a
    // period-less one is refused on create (QUOTA_PERIOD_MESSAGE) — so there
    // is no "count alone" row to make here; that legacy rendering rests on
    // `periodLabel(null)` being null, pinned in tr-quota-periods.test.ts.
    // Yearly is the period whose prompt defaults off, so it is asked for.
    const monthly = `E2E prompt monthly ${Date.now()}`
    const yearly = `E2E prompt yearly ${Date.now()}`
    const ids: number[] = []
    for (const [title, rrule] of [
      [monthly, 'FREQ=MONTHLY'],
      [yearly, 'FREQ=YEARLY'],
    ] as const) {
      const res = await page.request.post('/api/tasks', {
        data: {
          title,
          rrule,
          progress_target: 2,
          is_tracked: true,
          quota_prompt_config: rrule === 'FREQ=YEARLY' ? { enabled: true } : null,
        },
      })
      expect(res.ok()).toBeTruthy()
      const id = (await res.json()).data.id as number
      // Handed to cleanUp the moment it exists: a failure further down must
      // never leave a quota (and its prompt) behind for later specs — a leaked
      // one here once failed half of reminders.spec.ts.
      created.push(id)
      ids.push(id)
    }
    // The card shows one period at a time (it has something to show now):
    // move both prompts into whichever one that is.
    await page.goto('/')
    const panel = page.locator('section[data-reminders-panel]')
    await expect(panel).toBeVisible()
    const slotId = Number(await panel.getAttribute('data-reminders-slot'))
    expect(Number.isInteger(slotId)).toBeTruthy()
    for (const [i, id] of ids.entries()) {
      const res = await page.request.patch(`/api/tasks/${id}`, {
        data: {
          quota_prompt_config: i === 0 ? { slot_id: slotId } : { enabled: true, slot_id: slotId },
        },
      })
      expect(res.ok()).toBeTruthy()
    }
    await page.reload()
    const more = panel.getByRole('button', { name: /show more/i })
    if (await more.isVisible()) await more.click()
    const row = (title: string) => panel.locator('li[data-prompt-key]', { hasText: title })
    await expect(row(monthly)).toContainText('0/2 this month')
    await expect(row(yearly)).toContainText('0/2 this year')
  })

  /**
   * Every "it's gone" below has a positive control beside it, because a bare
   * `toHaveCount(0)` also passes on a page that has not rendered its list yet
   * (the Reminders region is on screen during the skeleton): the prompt is
   * seen on /reminders before the switch, a reminder in the same period must
   * render after it, and the server's own payload is checked too.
   *
   * The switch is put back by `cleanUp` (afterEach), pass or fail.
   */
  test('Settings: the quota reminders switch hides every prompt', async ({
    authenticatedPage: page,
  }) => {
    const [slot] = await userSlots(page)
    const quotaTitle = uniqueTitle('E2E prompt settings')
    const thoughtTitle = uniqueTitle('E2E settings thought')
    const quota = await makeQuota(page, quotaTitle)
    await placeIn(page, quota, { slot_id: slot.id })
    await makeReminder(page, thoughtTitle, slot)

    // On: the prompt is there — so its absence later means something.
    await page.goto('/reminders')
    await expect(reminderRow(page, thoughtTitle)).toBeVisible()
    await expect(promptRow(page, quotaTitle)).toBeVisible()

    await page.goto('/settings')
    const toggle = page.locator('[data-quota-prompts-switch]')
    await expect(toggle).toBeVisible()
    await expect(page.locator('[data-quota-prompt-slot]')).toBeVisible()
    const saved = waitForPreferenceSave(page, 'quota_prompts_enabled')
    await toggle.click()
    expect((await saved).ok()).toBeTruthy()
    await expect(page.locator('[data-quota-prompt-slot]')).toHaveCount(0)

    // The server stops sending prompts at all — not just the page hiding them.
    const payload = (await (await page.request.get('/api/reminders')).json()).data as {
      groups: { prompts?: unknown[] }[]
    }
    expect(payload.groups.flatMap((g) => g.prompts ?? [])).toEqual([])

    // Off: the period's reminder renders (the list is really there) and the
    // prompt beside it does not.
    await page.goto('/reminders')
    await expect(reminderRow(page, thoughtTitle)).toBeVisible()
    await expect(promptRow(page, quotaTitle)).toHaveCount(0)
    await expect(page.locator('li[data-prompt-key]')).toHaveCount(0)
  })
})

/**
 * Moving a prompt to another period for good (2026-09-25): the period chips
 * in its hold bubble — the quota editor's own PATCH, with the toast's Undo.
 */
test.describe('Quota prompts — moving', () => {
  test.afterEach(async ({ authenticatedPage: page }) => cleanUp(page))

  test('a period chip in the bubble moves a prompt for good; the toast Undo puts it back', async ({
    authenticatedPage: page,
  }) => {
    const id = await makeQuota(page, 'E2E prompt move')
    const slots = await userSlots(page)
    const last = slots[slots.length - 1]
    await page.goto('/reminders')
    const row = promptRow(page, 'E2E prompt move')
    await expect(row).toBeVisible()
    const from = await row.evaluate(
      (el) => el.closest('[data-slot-group]')!.getAttribute('data-slot-group')!,
    )
    expect(from).not.toBe(last.label)

    // The chips: every period, in start order, the current one pressed.
    const bubble = await holdOpen(page, row)
    const chips = bubble.locator('[data-prompt-period]')
    await expect(chips).toHaveText(slots.map((s) => s.label))
    await expect(bubble.locator('[data-prompt-period][aria-pressed="true"]')).toHaveText(from)

    const saved = page.waitForResponse(isQuotaPatch)
    await bubble.locator(`[data-prompt-period="${last.id}"]`).click()
    await expect(page.locator('[data-track-popover]')).toHaveCount(0)
    const body = await (await saved).json()
    expect(body.data.quota_prompt_config).toEqual({ slot_id: last.id })
    await expect(promptIn(page, last.label, 'E2E prompt move')).toBeVisible()
    await expect(promptIn(page, from, 'E2E prompt move')).toHaveCount(0)

    const toast = page.locator('[data-sonner-toast]', {
      hasText: `Moved “E2E prompt move” to ${last.label}`,
    })
    await expect(toast).toBeVisible()
    const undone = page.waitForResponse((r) => r.url().includes('/api/undo'))
    await toast.getByRole('button', { name: 'Undo' }).click()
    await undone
    await expect(promptIn(page, from, 'E2E prompt move')).toBeVisible()
    await expect(promptIn(page, last.label, 'E2E prompt move')).toHaveCount(0)
    const after = await page.request.get(`/api/tasks/${id}`)
    expect((await after.json()).data.quota_prompt_config).toBeNull()
  })

  test('a daily row moves only its own numbers — at phone width', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    const prefs = (await (await page.request.get('/api/user/preferences')).json()).data
    const slots = await userSlots(page)
    const [first, second] = slots
    const last = slots[slots.length - 1]
    await page.request.patch('/api/user/preferences', {
      data: { quota_prompt_slot_id: first.id },
    })
    try {
      await makeQuota(page, 'E2E prompt daily', 'FREQ=DAILY', 2)
      await page.goto('/reminders')
      await expect(promptIn(page, first.label, 'E2E prompt daily')).toBeVisible()
      const row = promptIn(page, second.label, 'E2E prompt daily')
      await expect(row).toBeVisible()
      // The count says which period it is counting: a daily quota's is today.
      await expect(row).toContainText('0/2 today')

      const bubble = await holdOpen(page, row)
      await expect(bubble.locator('[data-prompt-periods]')).toContainText(
        'The 2nd of 2 reminds me in',
      )
      // The bubble fits the phone: no chip is pushed past its right edge.
      const pop = (await bubble.boundingBox())!
      expect(pop.x + pop.width).toBeLessThanOrEqual(375)
      for (const chip of await bubble.locator('[data-prompt-period]').all()) {
        const b = (await chip.boundingBox())!
        expect(b.x + b.width).toBeLessThanOrEqual(pop.x + pop.width)
      }

      const saved = page.waitForResponse(isQuotaPatch)
      await bubble.locator(`[data-prompt-period="${last.id}"]`).click()
      const body = await (await saved).json()
      expect(body.data.quota_prompt_config).toEqual({ numbers: { '2': last.id } })
      await expect(promptIn(page, last.label, 'E2E prompt daily')).toBeVisible()
      await expect(promptIn(page, second.label, 'E2E prompt daily')).toHaveCount(0)
      // The 1st stays where it was.
      await expect(promptIn(page, first.label, 'E2E prompt daily')).toBeVisible()
    } finally {
      await page.request.patch('/api/user/preferences', {
        data: { quota_prompt_slot_id: prefs.quota_prompt_slot_id ?? null },
      })
    }
  })
})

test.describe('Quota prompts — notes mark', () => {
  test.afterEach(async ({ authenticatedPage: page }) => cleanUp(page))

  test('a quota with notes wears the notes mark on its prompt — on both surfaces', async ({
    authenticatedPage: page,
  }) => {
    // The same `NotesMarker` a reminder row wears (2026-09-25), from the
    // server's `has_notes`. Blank notes are no notes.
    const stamp = Date.now()
    const noted = `E2E prompt noted ${stamp}`
    const blank = `E2E prompt blank notes ${stamp}`
    const plain = `E2E prompt plain ${stamp}`
    const ids: number[] = []
    for (const [title, notes] of [
      [noted, 'Remember the good pan'],
      [blank, '   '],
      [plain, null],
    ] as const) {
      const res = await page.request.post('/api/tasks', {
        data: { title, rrule: 'FREQ=WEEKLY', progress_target: 2, is_tracked: true, notes },
      })
      expect(res.ok()).toBeTruthy()
      const id = (await res.json()).data.id as number
      created.push(id) // for cleanUp at once, even if a later create fails
      ids.push(id)
    }

    await page.goto('/reminders')
    await expect(promptRow(page, noted).locator('[data-has-notes]')).toHaveCount(1)
    await expect(promptRow(page, noted).getByLabel('Has notes')).toBeVisible()
    await expect(promptRow(page, blank)).toBeVisible()
    await expect(promptRow(page, blank).locator('[data-has-notes]')).toHaveCount(0)
    await expect(promptRow(page, plain).locator('[data-has-notes]')).toHaveCount(0)

    // The dashboard card shows one period at a time: move them all into it.
    await page.goto('/')
    const panel = page.locator('section[data-reminders-panel]')
    await expect(panel).toBeVisible()
    // A real period, not the un-slotted "Anytime" group the card may be on.
    await expect(panel).toHaveAttribute('data-reminders-slot', /^\d+$/)
    const slotId = Number(await panel.getAttribute('data-reminders-slot'))
    for (const id of ids) {
      const res = await page.request.patch(`/api/tasks/${id}`, {
        data: { quota_prompt_config: { slot_id: slotId } },
      })
      expect(res.ok()).toBeTruthy()
    }
    await page.reload()
    // Rows first (the card renders its toggle with them),
    // then ask whether a "Show more" is needed.
    const row = (title: string) => panel.locator('li[data-prompt-key]', { hasText: title })
    await expect(panel.locator('li').first()).toBeAttached()
    const more = panel.getByRole('button', { name: /show more/i })
    if (await more.isVisible()) await more.click()
    await expect(row(noted).getByLabel('Has notes')).toBeVisible()
    await expect(row(blank)).toBeVisible()
    await expect(row(blank).locator('[data-has-notes]')).toHaveCount(0)
    await expect(row(plain).locator('[data-has-notes]')).toHaveCount(0)
  })
})

/**
 * The Quotas page's multi-edit (2026-09-25): select several quotas → Details
 * now carries "Remind me daily" and the "Reminds me in" chips, with the same
 * "only what you change is applied" mixed state as How often and Label. The
 * write is ONE bulk edit of only the changed fields, merged per quota by the
 * server, and one Undo.
 */
test.describe('Quota prompts — multi-edit on the Quotas page', () => {
  test.afterEach(async ({ authenticatedPage: page }) => cleanUp(page))

  async function configure(page: Page, id: number, config: object) {
    const res = await page.request.patch(`/api/tasks/${id}`, {
      data: { quota_prompt_config: config },
    })
    expect(res.ok()).toBeTruthy()
  }

  async function configOf(page: Page, id: number) {
    const res = await page.request.get(`/api/tasks/${id}`)
    return (await res.json()).data.quota_prompt_config
  }

  /** Select exactly these rows on /quotas and open Details. */
  async function openDetails(page: Page, ids: number[]) {
    await gotoQuotasDetails(page)
    await page.locator(`[data-quota-row="${ids[0]}"]`).click()
    for (const id of ids.slice(1)) {
      await page.locator(`[data-quota-row="${id}"]`).click({ modifiers: ['ControlOrMeta'] })
    }
    const bar = page.locator('[data-quota-selection-bar]')
    await expect(bar).toContainText(`${ids.length} selected`)
    await bar.getByRole('button', { name: 'Details' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(`Editing ${ids.length} quotas`)
    return dialog.locator('[data-quota-prompt-field="many"]')
  }

  function isBulkEdit(r: { request(): { method(): string }; url(): string }) {
    return r.request().method() === 'POST' && r.url().includes('/api/tasks/bulk/edit')
  }

  test('a period for weekly and daily quotas at once — mixed first, one Undo after', async ({
    authenticatedPage: page,
  }) => {
    const slots = await userSlots(page)
    const [first, second] = slots
    const last = slots[slots.length - 1]
    const weekly = await makeQuota(page, 'E2E multi weekly', 'FREQ=WEEKLY', 3)
    const daily = await makeQuota(page, 'E2E multi daily', 'FREQ=DAILY', 3)
    await configure(page, weekly, { slot_id: last.id })
    await configure(page, daily, { slot_id: first.id, numbers: { '3': last.id } })

    const field = await openDetails(page, [weekly, daily])
    // Both remind (the default for weekly and daily): the switch agrees.
    await expect(field.locator('[data-quota-prompt-enabled]')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(field.locator('[data-quota-prompt-mixed="enabled"]')).toHaveCount(0)
    // They disagree about where: the dash, every period offered in order,
    // nothing pressed.
    await expect(field.locator('[data-quota-prompt-mixed="slot"]')).toHaveText('—')
    await expect(field.locator('[data-quota-prompt-slot]')).toHaveText(slots.map((s) => s.label))
    await expect(field.locator('[data-quota-prompt-slot][aria-pressed="true"]')).toHaveCount(0)

    await field.locator(`[data-quota-prompt-slot="${second.id}"]`).click()
    await expect(field.locator('[data-quota-prompt-mixed="slot"]')).toHaveCount(0)
    await expect(field.locator(`[data-quota-prompt-slot="${second.id}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const saved = page.waitForResponse(isBulkEdit)
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
    const res = await saved
    expect(res.ok()).toBeTruthy()
    // Only what changed goes: the period, and the daily numbers cleared so
    // they spread from it. The switch was left alone, so it is not sent.
    expect(res.request().postDataJSON()).toEqual({
      ids: expect.arrayContaining([weekly, daily]),
      changes: { quota_prompt_config: { slot_id: second.id, numbers: {} } },
    })
    expect(await configOf(page, weekly)).toEqual({ slot_id: second.id })
    expect(await configOf(page, daily)).toEqual({ slot_id: second.id })

    const toast = page.locator('[data-sonner-toast]', { hasText: 'Updated 2 quotas' })
    const undone = page.waitForResponse((r) => r.url().includes('/api/undo'))
    await toast.getByRole('button', { name: 'Undo' }).click()
    await undone
    expect(await configOf(page, weekly)).toEqual({ slot_id: last.id })
    expect(await configOf(page, daily)).toEqual({ slot_id: first.id, numbers: { '3': last.id } })

    // And the editor reads the restored disagreement again.
    await page.keyboard.press('Escape')
    const again = await openDetails(page, [weekly, daily])
    await expect(again.locator('[data-quota-prompt-mixed="slot"]')).toHaveText('—')
  })

  test('a mixed switch set to off hides the periods and keeps each quota its own period', async ({
    authenticatedPage: page,
  }) => {
    const last = (await userSlots(page)).at(-1)!
    const off = await makeQuota(page, 'E2E multi off', 'FREQ=WEEKLY', 2)
    const on = await makeQuota(page, 'E2E multi on', 'FREQ=MONTHLY', 2)
    await configure(page, off, { enabled: false, slot_id: last.id })
    await configure(page, on, { slot_id: last.id })

    const field = await openDetails(page, [off, on])
    const toggle = field.locator('[data-quota-prompt-enabled]')
    // One off, one on: the dash, and a switch that claims neither.
    await expect(field.locator('[data-quota-prompt-mixed="enabled"]')).toHaveText('—')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(field).toContainText('On for some of these, off for others')
    // Where they remind agrees, so it shows — pressed.
    await expect(field.locator(`[data-quota-prompt-slot="${last.id}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(field.locator('[data-quota-prompt-mixed="enabled"]')).toHaveCount(0)
    // Off: nothing reminds, so there is no period to pick.
    await expect(field.locator('[data-quota-prompt-slot]')).toHaveCount(0)
    await expect(field).toContainText('Only on the Quotas page')

    const saved = page.waitForResponse(isBulkEdit)
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
    const res = await saved
    expect(res.request().postDataJSON().changes).toEqual({
      quota_prompt_config: { enabled: false },
    })
    // The one already off was not rewritten; the other kept its period.
    expect((await res.json()).data.tasks_affected).toBe(1)
    expect(await configOf(page, off)).toEqual({ enabled: false, slot_id: last.id })
    expect(await configOf(page, on)).toEqual({ slot_id: last.id, enabled: false })
  })
})

/** A daily reminder at the start of this period, so it shares the prompt's card. */
async function makeReminder(page: Page, title: string, slot: { start_time: string }) {
  const [h, m] = slot.start_time.split(':').map(Number)
  const res = await page.request.post('/api/tasks', {
    data: { title, is_reminder: true, rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}` },
  })
  expect(res.ok()).toBeTruthy()
  const id = (await res.json()).data.id as number
  created.push(id)
  return id
}

async function placeIn(page: Page, id: number, config: object) {
  const res = await page.request.patch(`/api/tasks/${id}`, {
    data: { quota_prompt_config: config },
  })
  expect(res.ok()).toBeTruthy()
}

function reminderRow(page: Page, title: string) {
  return page.locator('li[data-reminder-id]', { hasText: title })
}

const bar = (page: Page) => page.locator('[data-selection-sheet]')

/**
 * Quota prompts in a multi-selection on /reminders (2026-09-25). Selected by
 * `prompt_key` beside reminders; the bar's Considered covers both in one
 * request and one Undo, Details opens the quota editor only for a
 * prompts-only selection, and Trash is never offered with a prompt selected.
 */
test.describe('Quota prompts — selection', () => {
  test.afterEach(async ({ authenticatedPage: page }) => cleanUp(page))

  test('a mixed selection is considered in one request, with one Undo', async ({
    authenticatedPage: page,
  }) => {
    const [slot] = await userSlots(page)
    const reminder = await makeReminder(page, 'E2E select thought', slot)
    const quota = await makeQuota(page, 'E2E select quota')
    await placeIn(page, quota, { slot_id: slot.id })
    await page.goto('/reminders')
    const thought = reminderRow(page, 'E2E select thought')
    const prompt = promptRow(page, 'E2E select quota')
    await expect(thought).toBeVisible()
    await expect(prompt).toBeVisible()
    const key = await prompt.getAttribute('data-prompt-key')

    await thought.click({ modifiers: ['ControlOrMeta'] })
    await prompt.click({ modifiers: ['ControlOrMeta'] })
    await expect(prompt).toHaveAttribute('aria-selected', 'true')
    await expect(bar(page)).toContainText('2 selected')

    const completions: string[] = []
    page.on('request', (r) => {
      if (/\/done$|\/bulk\/(done|complete)$|\/quota-prompts\//.test(r.url())) {
        completions.push(r.url())
      }
    })
    const sent = page.waitForResponse((r) => r.url().includes('/api/tasks/bulk/complete'))
    await bar(page).getByRole('button', { name: 'Considered' }).click()
    const res = await sent
    expect(res.ok()).toBeTruthy()
    expect(res.request().postDataJSON()).toEqual({
      ids: [reminder],
      prompts: [{ key, did: false }],
    })
    await expect(thought).toHaveCount(0)
    await expect(prompt).toHaveCount(0)
    expect(completions).toHaveLength(1)
    // Considered, never +1.
    expect(await progressOf(page, quota)).toBe(0)

    // One Undo brings both back.
    const undone = page.waitForResponse((r) => r.url().includes('/api/undo'))
    await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
    await undone
    await expect(reminderRow(page, 'E2E select thought')).toBeVisible()
    await expect(promptRow(page, 'E2E select quota')).toBeVisible()
  })

  test('a mixed selection (a Shift-click range) disables Details and offers no Trash', async ({
    authenticatedPage: page,
  }) => {
    const [slot] = await userSlots(page)
    await makeReminder(page, 'E2E range thought', slot)
    const quota = await makeQuota(page, 'E2E range quota')
    await placeIn(page, quota, { slot_id: slot.id })
    await page.goto('/reminders')
    const thought = reminderRow(page, 'E2E range thought')
    const prompt = promptRow(page, 'E2E range quota')
    await expect(prompt).toBeVisible()

    // Reminders only: Details and Trash, as always.
    await thought.click({ modifiers: ['ControlOrMeta'] })
    await expect(bar(page).getByRole('button', { name: 'Details' })).toBeEnabled()
    await expect(bar(page).getByRole('button', { name: /to trash/i })).toHaveCount(1)

    // Shift-click runs the range from the reminder across to the prompt.
    await prompt.click({ modifiers: ['Shift'] })
    await expect(prompt).toHaveAttribute('aria-selected', 'true')
    // While selecting, the row offers only its checkbox — no "did it" square.
    await expect(prompt.locator('[data-prompt-did]')).toBeHidden()
    await expect(thought).toHaveAttribute('aria-selected', 'true')
    await expect(bar(page).getByRole('button', { name: 'Details' })).toBeDisabled()
    await expect(bar(page).locator('[data-selection-hint]')).toHaveText(
      'Details: pick only reminders or only quotas',
    )
    await expect(bar(page).getByRole('button', { name: /to trash/i })).toHaveCount(0)

    // The prompt alone: still no Trash; Details is back (for the quota).
    await thought.click()
    await expect(thought).toHaveAttribute('aria-selected', 'false')
    await expect(bar(page).getByRole('button', { name: 'Details' })).toBeEnabled()
    await expect(bar(page).locator('[data-selection-hint]')).toHaveCount(0)
    await expect(bar(page).getByRole('button', { name: /to trash/i })).toHaveCount(0)
    // A selection-mode tap never considered either of them.
    await expect(prompt).toBeVisible()
    await expect(thought).toBeVisible()
    expect(await progressOf(page, quota)).toBe(0)
  })

  test('a prompts-only selection opens Details on its quotas, deduped', async ({
    authenticatedPage: page,
  }) => {
    const slots = await userSlots(page)
    const [first, second] = slots
    const last = slots[slots.length - 1]
    const weekly = await makeQuota(page, 'E2E details weekly')
    const other = await makeQuota(page, 'E2E details untouched')
    const daily = await makeQuota(page, 'E2E details daily', 'FREQ=DAILY', 2)
    await placeIn(page, weekly, { slot_id: first.id })
    await placeIn(page, other, { slot_id: first.id })
    await placeIn(page, daily, { slot_id: first.id, numbers: { '2': second.id } })
    await page.goto('/reminders')

    const dailyFirst = promptIn(page, first.label, 'E2E details daily')
    const dailySecond = promptIn(page, second.label, 'E2E details daily')
    await expect(promptRow(page, 'E2E details untouched')).toBeVisible()
    await promptRow(page, 'E2E details weekly').click({ modifiers: ['ControlOrMeta'] })
    await dailyFirst.click({ modifiers: ['ControlOrMeta'] })
    await dailySecond.click({ modifiers: ['ControlOrMeta'] })
    await expect(bar(page)).toContainText('3 selected')
    await expect(bar(page).getByRole('button', { name: /to trash/i })).toHaveCount(0)

    await bar(page).getByRole('button', { name: 'Details' }).click()
    const dialog = page.getByRole('dialog')
    // Three prompts, two quotas: the daily one's two rows are one quota.
    await expect(dialog).toContainText('Editing 2 quotas')
    const field = dialog.locator('[data-quota-prompt-field="many"]')
    await field.locator(`[data-quota-prompt-slot="${last.id}"]`).click()
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes('/api/tasks/bulk/edit'),
    )
    await dialog.getByRole('button', { name: 'Save' }).click()
    const res = await saved
    expect(res.ok()).toBeTruthy()
    const ids = res.request().postDataJSON().ids as number[]
    expect([...ids].sort((a, b) => a - b)).toEqual([weekly, daily].sort((a, b) => a - b))
  })

  test("a daily quota's two prompts select separately", async ({ authenticatedPage: page }) => {
    const [first, second] = await userSlots(page)
    const daily = await makeQuota(page, 'E2E select daily', 'FREQ=DAILY', 2)
    await placeIn(page, daily, { slot_id: first.id, numbers: { '2': second.id } })
    await page.goto('/reminders')
    const one = promptIn(page, first.label, 'E2E select daily')
    const two = promptIn(page, second.label, 'E2E select daily')
    await expect(one).toBeVisible()
    await expect(two).toBeVisible()
    const keys = [
      await one.getAttribute('data-prompt-key'),
      await two.getAttribute('data-prompt-key'),
    ]
    expect(keys[0]).not.toBe(keys[1])

    await one.click({ modifiers: ['ControlOrMeta'] })
    await expect(one).toHaveAttribute('aria-selected', 'true')
    await expect(two).toHaveAttribute('aria-selected', 'false')
    // In selection mode a plain tap adds the other: its own row, its own key.
    await two.click()
    await expect(two).toHaveAttribute('aria-selected', 'true')
    await expect(bar(page)).toContainText('2 selected')
    await one.click()
    await expect(one).toHaveAttribute('aria-selected', 'false')
    await expect(two).toHaveAttribute('aria-selected', 'true')
    await one.click()
    await expect(bar(page)).toContainText('2 selected')

    // Both, considered together: the prompts' own endpoint, both keys, no +1.
    const sent = page.waitForResponse((r) => r.url().includes('/api/quota-prompts/consider'))
    await bar(page).getByRole('button', { name: 'Considered' }).click()
    const res = await sent
    expect(res.ok()).toBeTruthy()
    expect([...res.request().postDataJSON().keys].sort()).toEqual([...keys].sort())
    await expect(one).toHaveCount(0)
    await expect(two).toHaveCount(0)
    expect(await progressOf(page, daily)).toBe(0)
  })
})

/** Does any value anywhere inside `body` say `did: true`? */
function saysDid(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(saysDid)
  if (body && typeof body === 'object') {
    return Object.entries(body).some(([k, v]) => (k === 'did' && v === true) || saysDid(v))
  }
  return false
}

/**
 * The selection bar only ever CONSIDERS a prompt: "did it" is the row's own
 * square, a deliberate +1, and a bulk action must never log progress on the
 * user's behalf (testing-pass plan §1b). Watched from the wire: every POST
 * the page makes while the bar acts, for a prompts-only selection (the
 * prompts' own consider endpoint) and a mixed one (bulk/complete).
 */
test.describe('Quota prompts — the bar never logs progress', () => {
  test.afterEach(async ({ authenticatedPage: page }) => cleanUp(page))

  test('Considered from the bar never sends did: true — prompts alone or mixed', async ({
    authenticatedPage: page,
  }) => {
    const [first, second] = await userSlots(page)
    const weeklyTitle = uniqueTitle('E2E bar weekly')
    const dailyTitle = uniqueTitle('E2E bar daily')
    const thoughtTitle = uniqueTitle('E2E bar thought')
    const weekly = await makeQuota(page, weeklyTitle)
    const daily = await makeQuota(page, dailyTitle, 'FREQ=DAILY', 2)
    await placeIn(page, weekly, { slot_id: first.id })
    await placeIn(page, daily, { slot_id: first.id, numbers: { '2': second.id } })
    const reminder = await makeReminder(page, thoughtTitle, first)

    const posts: { path: string; body: unknown }[] = []
    const onRequest = (r: Request) => {
      if (r.method() !== 'POST') return
      posts.push({ path: new URL(r.url()).pathname, body: r.postDataJSON() })
    }
    page.on('request', onRequest)
    try {
      await page.goto('/reminders')
      const weeklyRow = promptRow(page, weeklyTitle)
      const dailyOne = promptIn(page, first.label, dailyTitle)
      const dailyTwo = promptIn(page, second.label, dailyTitle)
      const thought = reminderRow(page, thoughtTitle)
      await expect(dailyTwo).toBeVisible()
      await expect(thought).toBeVisible()
      const weeklyKey = await weeklyRow.getAttribute('data-prompt-key')
      const oneKey = await dailyOne.getAttribute('data-prompt-key')
      const twoKey = await dailyTwo.getAttribute('data-prompt-key')

      // Prompts only → the prompts' consider endpoint.
      await weeklyRow.click({ modifiers: ['ControlOrMeta'] })
      await dailyOne.click({ modifiers: ['ControlOrMeta'] })
      await expect(bar(page)).toContainText('2 selected')
      const considered = page.waitForResponse((r) =>
        r.url().includes('/api/quota-prompts/consider'),
      )
      await bar(page).getByRole('button', { name: 'Considered' }).click()
      const first_ = await considered
      expect(first_.ok()).toBeTruthy()
      expect([...first_.request().postDataJSON().keys].sort()).toEqual([weeklyKey, oneKey].sort())
      await expect(weeklyRow).toHaveCount(0)
      await expect(dailyOne).toHaveCount(0)

      // A reminder and a prompt → one bulk/complete, the prompt as considered.
      await thought.click({ modifiers: ['ControlOrMeta'] })
      await dailyTwo.click({ modifiers: ['ControlOrMeta'] })
      await expect(bar(page)).toContainText('2 selected')
      const completed = page.waitForResponse((r) => r.url().includes('/api/tasks/bulk/complete'))
      await bar(page).getByRole('button', { name: 'Considered' }).click()
      const second_ = await completed
      expect(second_.ok()).toBeTruthy()
      expect(second_.request().postDataJSON()).toEqual({
        ids: [reminder],
        prompts: [{ key: twoKey, did: false }],
      })
      await expect(dailyTwo).toHaveCount(0)

      // What went over the wire: all three keys (so the watch below is not
      // looking at an empty list), and not one "did it".
      const sent = JSON.stringify(posts.map((p) => p.body))
      for (const key of [weeklyKey, oneKey, twoKey]) expect(sent).toContain(key!)
      expect(posts.map((p) => p.path)).not.toContain('/api/quota-prompts/did')
      expect(posts.filter((p) => saysDid(p.body))).toEqual([])
      // And the server agrees: nothing was logged.
      expect(await progressOf(page, weekly)).toBe(0)
      expect(await progressOf(page, daily)).toBe(0)
    } finally {
      page.off('request', onRequest)
    }
  })
})

/**
 * Prompts count toward "waiting so far" exactly like reminders do
 * (`summarizeReminders`): the headline and the nav badge must agree with a
 * prompt in the picture, and handling the prompt must move both.
 *
 * A prompt only counts once its period has started. So the prompt goes into
 * the latest period that has started — whose status cannot change for the
 * rest of the day — and must move both numbers by one. Before the day's first
 * period there is no such slot: the prompt goes into the first one and must
 * move neither. Either way the two numbers agree at every step.
 *
 * Two narrow windows are left, deliberately not papered over with a guard: the
 * first period starting during the few seconds of an early-morning run, and a
 * run straddling local midnight (prompt keys are per day).
 */
test.describe('Quota prompts — the headline and the nav badge', () => {
  test.afterEach(async ({ authenticatedPage: page }) => cleanUp(page))

  test('agree with a prompt counted, and both move when it is handled', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const slots = await userSlots(page)
    const now = DateTime.now().setZone(TEST_TZ)
    const minutes = now.hour * 60 + now.minute
    const toMinutes = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number)
      return h * 60 + m
    }
    const started = slots.filter((s) => toMinutes(s.start_time) <= minutes).at(-1)
    const target = started ?? slots[0]
    const counts = started ? 1 : 0

    const title = uniqueTitle('E2E prompt badge')
    const id = await makeQuota(page, title)
    await placeIn(page, id, { slot_id: target.id })

    const prompt = promptIn(page, target.label, title)
    // Once the row is up, every reminders fetch the page started (the view's
    // and the badge's) has finished: the numbers read below are final.
    await waitForGetsSettled(page, '/api/reminders', () => page.goto('/reminders'), prompt)
    const read = async () => {
      const headline = page.locator('[data-reminders-headline] [data-waiting-so-far]')
      const badge = page.locator('aside [data-reminders-badge]')
      return {
        headline: (await headline.count())
          ? Number(await headline.getAttribute('data-waiting-so-far'))
          : 0,
        badge: (await badge.count()) ? Number(await badge.innerText()) : 0,
      }
    }
    const before = await read()
    expect(before.badge).toBe(before.headline)
    expect(before.headline).toBeGreaterThanOrEqual(counts)

    const considered = page.waitForResponse((r) => r.url().includes('/api/quota-prompts/consider'))
    await prompt.locator('[data-prompt-consider]').click()
    expect((await considered).ok()).toBeTruthy()
    await expect(prompt).toHaveCount(0)
    const after = before.headline - counts
    await expect.poll(read).toEqual({ headline: after, badge: after })
  })
})

test.describe('Quota prompts — put back', () => {
  test.afterEach(async ({ authenticatedPage: page }) => cleanUp(page))

  test('a handled prompt is put back from "Show N considered": the did-it comes off, and it waits again', async ({
    authenticatedPage: page,
  }) => {
    const title = `E2E prompt put back ${Date.now()}`
    const id = await makeQuota(page, title)
    await page.goto('/reminders')
    const row = promptRow(page, title)
    await expect(row).toBeVisible()
    const card = page.locator('[data-slot-group]', { has: row })
    const slot = await card.getAttribute('data-slot-group')

    const did = page.waitForResponse((r) => r.url().includes('/api/quota-prompts/did'))
    await row.locator('[data-prompt-did]').click()
    expect((await did).ok()).toBeTruthy()
    await expect(promptRow(page, title)).toHaveCount(0)
    expect(await progressOf(page, id)).toBe(1)

    // It is listed with the slot's considered reminders, wearing the filled
    // dashed circle it collapsed with — and that circle puts it back.
    const slotCard = page.locator(`[data-slot-group="${slot}"]`)
    await slotCard.getByRole('button', { name: /^Show \d+ considered$/ }).click()
    const handled = slotCard.locator('li[data-considered-prompt]', { hasText: title })
    await expect(handled).toContainText('1/3 this week')
    const putBack = handled.getByRole('button', { name: `Put back "${title}"` })
    await expect(putBack.locator('svg[data-dashed-ring]')).toBeVisible()

    const restore = page.waitForResponse((r) => r.url().includes('/api/quota-prompts/restore'))
    await putBack.click()
    expect((await restore).ok()).toBeTruthy()
    // Never /undone: a quota refuses it.
    await expect(promptRow(page, title)).toBeVisible()
    await expect(promptRow(page, title)).toContainText('0/3 this week')
    await expect(handled).toHaveCount(0)
    expect(await progressOf(page, id)).toBe(0)

    // Undo reverses the put-back — one entry: handled again, with its +1.
    const undone = page.waitForResponse((r) => r.url().includes('/api/undo'))
    await page.getByRole('banner').getByRole('button', { name: /^Undo/ }).click()
    await undone
    await expect(promptRow(page, title)).toHaveCount(0)
    expect(await progressOf(page, id)).toBe(1)
  })

  test('the dashboard card puts a considered prompt back from its considered list', async ({
    authenticatedPage: page,
  }) => {
    const title = `E2E prompt card put back ${Date.now()}`
    const id = await makeQuota(page, title)
    await page.goto('/')
    const panel = page.locator('section[data-reminders-panel]')
    await expect(panel).toBeVisible()
    const slotId = Number(await panel.getAttribute('data-reminders-slot'))
    const moved = await page.request.patch(`/api/tasks/${id}`, {
      data: { quota_prompt_config: { slot_id: slotId } },
    })
    expect(moved.ok()).toBeTruthy()
    const [prompt] = (
      (await (await page.request.get('/api/reminders')).json()).data.groups as {
        prompts: { prompt_key: string; task_id: number }[]
      }[]
    )
      .flatMap((g) => g.prompts)
      .filter((p) => p.task_id === id)
    const considered = await page.request.post('/api/quota-prompts/consider', {
      data: { keys: [prompt.prompt_key] },
    })
    expect(considered.ok()).toBeTruthy()
    await page.reload()

    await panel.locator('[data-considered-toggle]').click()
    const handled = panel.locator('li[data-considered-prompt]', { hasText: title })
    await expect(handled).toContainText('0/3 this week')
    const restore = page.waitForResponse((r) => r.url().includes('/api/quota-prompts/restore'))
    await handled.getByRole('button', { name: `Put back "${title}"` }).click()
    expect((await restore).ok()).toBeTruthy()
    const more = panel.getByRole('button', { name: /show more/i })
    if (await more.isVisible()) await more.click()
    await expect(panel.locator('li[data-prompt-key]', { hasText: title })).toBeVisible()
    expect(await progressOf(page, id)).toBe(0)
  })
})
