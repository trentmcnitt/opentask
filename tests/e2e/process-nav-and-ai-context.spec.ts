/**
 * Process's place in the navigation, and the AI-context nudge's move into
 * Settings (2026-10-14, mockup P1):
 *
 * 1. Desktop left bar: Process is its own block between dividers, below Add
 *    Task and above Archive — a plain row, no count. It opens the one Process
 *    modal in place on the dashboard, and from a page without the top bar
 *    (History) it goes to the dashboard and opens it there.
 * 2. Phone ☰ menu: Add Task, divider, Process, divider, then the destinations.
 *    Add Task opens the task form; it is phone-only.
 * 3. The "Review AI context" link is gone from the left bar and the ☰ menu,
 *    even when it would have shown (AI on, never stamped).
 * 4. Settings › AI shows the context's age ("No update date", "Updated 3
 *    weeks ago", …), a stale emphasis at 21+ days or no date, and "Still
 *    accurate", which restamps it. /settings#ai-context focuses the field.
 *
 * E2E runs with AI off, so the AI cases (3, 4) turn `ai_available` on in the
 * page's preferences read (`page.route`); every write still goes to the real
 * server. Each runs light and dark, at 1280x800 and (where it applies)
 * 375x812.
 */
import path from 'path'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import { test, expect, waitForPrefsLoaded } from './fixtures'

const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 375, height: 812 }
const DAY = 24 * 60 * 60 * 1000
const THEMES = ['light', 'dark'] as const

/**
 * Serve the preferences read with AI available and, when given, this
 * `ai_context_updated_at` (`undefined` keeps the server's). Only the GET is
 * changed; writes go through untouched.
 */
async function withAiOn(page: Page, stamp?: string | null) {
  await page.route('**/api/user/preferences', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    body.data.ai_available = true
    if (stamp !== undefined) body.data.ai_context_updated_at = stamp
    await route.fulfill({ response, json: body })
  })
}

/** The seeded user's stamp, read and written straight from the E2E database (never via the API, which can't clear it). */
function readStamp(): string | null {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    const row = db.prepare('SELECT ai_context_updated_at FROM users WHERE id = 1').get() as {
      ai_context_updated_at: string | null
    }
    return row.ai_context_updated_at
  } finally {
    db.close()
  }
}

function writeStamp(stamp: string | null) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare('UPDATE users SET ai_context_updated_at = ? WHERE id = 1').run(stamp)
  } finally {
    db.close()
  }
}

for (const theme of THEMES) {
  test.describe(`Process in the navigation (${theme})`, () => {
    test.use({ colorScheme: theme })

    test('desktop: Process is its own block below Add Task, a plain row that opens Process', async ({
      authenticatedPage: page,
    }) => {
      await page.setViewportSize(DESKTOP)
      await page.goto('/')
      const aside = page.locator('aside')
      const process = aside.locator('[data-sidebar-process]')
      await expect(process).toBeVisible()
      // Plain: the word and nothing else — no count, no subtitle.
      await expect(process).toHaveText('Process')

      // Add Task, Process and the destinations are three separate blocks, in
      // that order, each with its own top divider.
      const addTask = aside.getByRole('button', { name: 'Add Task' })
      const archive = aside.getByRole('link', { name: 'Archive' })
      const blockOf = (el: typeof process) => el.locator('xpath=ancestor::div[1]')
      const [addBox, processBox, archiveBox] = await Promise.all([
        addTask.boundingBox(),
        process.boundingBox(),
        archive.boundingBox(),
      ])
      expect(addBox!.y).toBeLessThan(processBox!.y)
      expect(processBox!.y).toBeLessThan(archiveBox!.y)
      for (const el of [addTask, process, archive]) {
        await expect(blockOf(el)).toHaveClass(/\bborder-t\b/)
      }
      const processBlock = blockOf(process)
      await expect(processBlock.getByRole('button', { name: 'Add Task' })).toHaveCount(0)
      await expect(processBlock.getByRole('link', { name: 'Archive' })).toHaveCount(0)

      await page.screenshot({ path: `.tmp/e2e-process-sidebar-desktop-${theme}.png` })

      // On the dashboard it opens Process in place.
      await process.click()
      await expect(page.locator('[data-process-modal]')).toBeVisible()
      await expect(page).toHaveURL(/\/$/)
    })

    test('desktop: from a page without the top bar, Process goes to the dashboard and opens there', async ({
      authenticatedPage: page,
    }) => {
      await page.setViewportSize(DESKTOP)
      await page.goto('/history')
      const process = page.locator('aside [data-sidebar-process]')
      await expect(process).toBeVisible()
      await process.click()
      await expect(page.locator('[data-process-modal]')).toBeVisible()
      // Landed on the dashboard, the one-shot `?action=process` consumed.
      await expect(page).toHaveURL(/\/$/)
    })

    test('phone ☰ menu: Add Task, divider, Process, divider, then the destinations', async ({
      authenticatedPage: page,
    }) => {
      await page.setViewportSize(PHONE)
      await page.goto('/')
      await page.getByRole('button', { name: 'Menu' }).click()
      const menu = page.getByRole('menu')
      await expect(menu).toBeVisible()

      // Each visible entry of the menu, in order: an item's text, or "—" for
      // a divider. The signed-in label (and its divider) above them is not an
      // entry, so the list starts at the first item.
      const all = await menu.evaluate((el) =>
        Array.from(el.children)
          .filter((c) => (c as HTMLElement).offsetParent !== null)
          .map((c) => {
            const role = c.getAttribute('role')
            if (role === 'separator') return '—'
            // innerText: what shows (the desktop-only ⌘⇧Z hint is hidden here).
            if (role === 'menuitem') return (c as HTMLElement).innerText.trim()
            return null
          })
          .filter((e): e is string => e !== null),
      )
      const first = all.findIndex((e) => e !== '—')
      expect(all.slice(0, first).every((e) => e === '—')).toBe(true)
      const entries = all.slice(first)
      expect(entries.slice(0, 8)).toEqual([
        'Add Task',
        '—',
        'Process',
        '—',
        'Archive',
        'Trash',
        'Settings',
        'Docs',
      ])
      // The destinations end a block of their own; the tools follow (AI is
      // off in E2E, so no AI Status; Shortcuts is desktop-only).
      expect(entries.slice(8)).toEqual(['—', 'Redo', 'Theme'])

      await page.screenshot({ path: `.tmp/e2e-process-menu-phone-${theme}.png` })

      // Add Task opens the task form.
      await menu.getByRole('menuitem', { name: 'Add Task' }).click()
      await expect(page.getByRole('dialog', { name: 'New Task' })).toBeVisible()
    })

    test('desktop ☰ menu: Process at the top, no Add Task (the left bar has it)', async ({
      authenticatedPage: page,
    }) => {
      await page.setViewportSize(DESKTOP)
      await page.goto('/')
      await page.getByRole('button', { name: 'Menu' }).click()
      const menu = page.getByRole('menu')
      await expect(menu.locator('[data-process-menu-item]')).toHaveText('Process')
      await expect(menu.locator('[data-menu-add]')).toBeHidden()
      await menu.locator('[data-process-menu-item]').click()
      await expect(page.locator('[data-process-modal]')).toBeVisible()
    })
  })

  test.describe(`AI context in Settings › AI (${theme})`, () => {
    test.use({ colorScheme: theme })

    test('the old "Review AI context" link is gone from the left bar and the ☰ menu', async ({
      authenticatedPage: page,
    }) => {
      // AI on and never stamped: exactly when the link used to show.
      await withAiOn(page, null)
      await page.setViewportSize(DESKTOP)
      await waitForPrefsLoaded(
        page,
        () => page.goto('/settings'),
        page.getByRole('heading', { name: 'AI Context' }),
      )
      await expect(page.locator('aside').getByRole('link', { name: 'Settings' })).toBeVisible()
      await expect(page.locator('aside a[href="/settings#ai-context"]')).toHaveCount(0)
      await expect(page.locator('aside').getByText(/AI context/i)).toHaveCount(0)

      await page.setViewportSize(PHONE)
      await page.goto('/')
      await page.getByRole('button', { name: 'Menu' }).click()
      const menu = page.getByRole('menu')
      await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeVisible()
      await expect(menu.locator('a[href="/settings#ai-context"]')).toHaveCount(0)
      await expect(menu.getByText(/AI context/i)).toHaveCount(0)
    })

    for (const viewport of [DESKTOP, PHONE]) {
      const size = `${viewport.width}x${viewport.height}`

      test(`${size}: no update date reads stale; "Still accurate" restamps it`, async ({
        authenticatedPage: page,
      }) => {
        const before = readStamp()
        writeStamp(null)
        try {
          await withAiOn(page)
          await page.setViewportSize(viewport)
          await waitForPrefsLoaded(
            page,
            () => page.goto('/settings#ai-context'),
            page.locator('[data-ai-context-field]'),
          )
          // The deep link still lands on the field.
          await expect(page.locator('[data-ai-context-field]')).toBeFocused()

          const age = page.locator('[data-ai-context-age]')
          await expect(age).toHaveText('No update date')
          await expect(age).toHaveAttribute('data-stale', 'true')
          await page.screenshot({ path: `.tmp/e2e-ai-context-${size}-${theme}.png` })

          const reviewed = page.locator('[data-ai-context-reviewed]')
          await expect(reviewed).toBeVisible()
          const saved = page.waitForResponse(
            (r) => r.url().endsWith('/api/user/preferences') && r.request().method() === 'PATCH',
          )
          await reviewed.click()
          expect((await saved).ok()).toBe(true)

          await expect(age).toHaveText('Updated today')
          await expect(age).not.toHaveAttribute('data-stale')
          await expect(reviewed).toHaveCount(0)
          expect(readStamp()).not.toBeNull()
        } finally {
          writeStamp(before)
        }
      })
    }

    test('3+ weeks old reads in weeks, stale; a few days old is fresh, with no "Still accurate"', async ({
      authenticatedPage: page,
    }) => {
      await page.setViewportSize(DESKTOP)
      await withAiOn(page, new Date(Date.now() - 25 * DAY).toISOString())
      await waitForPrefsLoaded(
        page,
        () => page.goto('/settings'),
        page.locator('[data-ai-context-field]'),
      )
      const age = page.locator('[data-ai-context-age]')
      await expect(age).toHaveText('Updated 3 weeks ago')
      await expect(age).toHaveAttribute('data-stale', 'true')
      await expect(page.locator('[data-ai-context-reviewed]')).toBeVisible()

      await page.unroute('**/api/user/preferences')
      await withAiOn(page, new Date(Date.now() - 3 * DAY).toISOString())
      await waitForPrefsLoaded(page, () => page.reload(), page.locator('[data-ai-context-field]'))
      await expect(age).toHaveText('Updated 3 days ago')
      await expect(age).not.toHaveAttribute('data-stale')
      await expect(page.locator('[data-ai-context-reviewed]')).toHaveCount(0)
    })
  })
}
