import { test, expect, cmdClickRow, uniqueTitle, withPreferences } from './fixtures'
import type { Locator, Page } from '@playwright/test'

/**
 * The desktop task dialogs must lay the quick panel out inside their own
 * 448px width, whatever the task holds.
 *
 * Regression (2026-09-29): the selection bar's "More" dialog titles itself
 * with the task title in a `truncate` (nowrap) DialogTitle. `DialogContent`
 * is a CSS grid whose one implicit `auto` column grew to that title's
 * one-line width (~650px), so the whole panel — snooze grid, Save/Reset row,
 * notes — was laid out that wide and `overflow-x-hidden` cut its right half
 * off. Fixed with `grid-cols-1` (`minmax(0, 1fr)`) in `ui/dialog.tsx`. The
 * notes preview also needed `break-words` for an unbroken path once "more"
 * unclamps it.
 *
 * Two checks, because either alone misses a case: every descendant's box ends
 * inside the dialog (the widened-column bug), and the dialog has nothing to
 * scroll sideways (text running out of a correctly sized box, which leaves
 * every box inside). Radix's visually-hidden title/description are 1px
 * `sr-only` boxes and are skipped.
 */

const LONG_TITLE = 'Fill out the school forms and upload the immunization records to the portal'
const LONG_NOTES = [
  'The portal takes PDFs only.',
  'Saved at handouts/2026_09_22_some_long_file_name_immunization_records_for_the_school_forms_final.pdf',
  'Bring a printed copy.',
  'Ask about the fall schedule.',
].join('\n')

async function expectNothingPastTheRightEdge(dialog: Locator): Promise<void> {
  const report = await dialog.evaluate((d) => {
    const edge = d.getBoundingClientRect().right
    const past: string[] = []
    for (const el of d.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width <= 1) continue
      if (r.right > edge + 0.5) {
        past.push(
          `${el.tagName} "${(el.getAttribute('class') ?? '').slice(0, 60)}" ends at ${Math.round(r.right)} > ${edge}`,
        )
      }
    }
    return { past, scrollWidth: d.scrollWidth, clientWidth: d.clientWidth }
  })
  expect(report.past).toEqual([])
  expect(report.scrollWidth).toBeLessThanOrEqual(report.clientWidth)
}

async function createLongTask(page: Page): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: {
      title: uniqueTitle(LONG_TITLE),
      notes: LONG_NOTES,
      priority: 3,
      due_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
    },
  })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

test.describe('Quick panel dialogs fit long content', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 1512, height: 900 })
  })

  test('the selection bar’s More dialog, with a long title and unbroken notes', async ({
    authenticatedPage: page,
  }) => {
    const id = await createLongTask(page)
    try {
      await withPreferences(page, { default_grouping: 'time' }, async () => {
        await page.goto('/')
        const row = page.locator(`#task-row-${id}`)
        await cmdClickRow(row)
        await page.getByRole('button', { name: 'More', exact: true }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByRole('button', { name: 'Save' })).toBeVisible()
        await expectNothingPastTheRightEdge(dialog)

        // Unclamp the notes: the unbroken path must wrap, not run out.
        await dialog.getByRole('button', { name: 'more', exact: true }).click()
        await expect(dialog.getByRole('button', { name: 'less', exact: true })).toBeVisible()
        await expectNothingPastTheRightEdge(dialog)
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('the double-click quick panel, with a long title and unbroken notes', async ({
    authenticatedPage: page,
  }) => {
    const id = await createLongTask(page)
    try {
      await withPreferences(page, { default_grouping: 'time' }, async () => {
        await page.goto('/')
        const row = page.locator(`#task-row-${id}`)
        await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
        const box = await row.boundingBox()
        if (!box) throw new Error('row not on screen')
        // The row's own padding: not the title (a link) and not the Done circle.
        await row.dblclick({ position: { x: 56, y: box.height - 6 } })
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByRole('button', { name: 'Save' })).toBeVisible()
        await expectNothingPastTheRightEdge(dialog)

        await dialog.getByRole('button', { name: 'more', exact: true }).click()
        await expect(dialog.getByRole('button', { name: 'less', exact: true })).toBeVisible()
        await expectNothingPastTheRightEdge(dialog)
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })
})
