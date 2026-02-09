import { test, expect } from './fixtures'

/**
 * AI feature E2E tests.
 *
 * E2E tests run without AI configured (no OPENAI_API_KEY in the Playwright
 * webServer env), so AI endpoints return 503. These tests verify graceful
 * degradation: the app works normally, AI-dependent panels don't render,
 * and the AI Status modal shows a meaningful "not available" state.
 */
test.describe('AI features (disabled)', () => {
  test('AI Status modal opens from hamburger menu and shows not-available state', async ({
    authenticatedPage: page,
  }) => {
    // Open the hamburger menu
    await page.getByRole('button', { name: 'Menu' }).click()

    // Click "AI Status" menu item
    await page.getByRole('menuitem', { name: 'AI Status' }).click()

    // The modal should open with "AI Status" as the title
    await expect(page.getByRole('heading', { name: 'AI Status' })).toBeVisible({ timeout: 5000 })

    // When AI is disabled, the status endpoint returns non-ok, so the modal
    // shows the error state: "AI features are not available."
    await expect(page.getByText('AI features are not available.')).toBeVisible({ timeout: 5000 })

    // A "Retry" button should be available
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  test('BubblePanel does not render when AI is disabled', async ({ authenticatedPage: page }) => {
    // Wait for the page to fully load and any fetch calls to settle
    await page.waitForLoadState('networkidle')

    // The BubblePanel shows "Analyzing your tasks..." while loading,
    // and renders with a blue border when data is available.
    // When AI returns 503, the component returns null — nothing renders.
    await expect(page.getByText('Analyzing your tasks')).not.toBeVisible()

    // Also verify the Sparkles-based summary area is absent
    // (BubblePanel header uses a Sparkles icon with blue styling)
    const bubbleContainer = page.locator('.border-blue-200.bg-blue-50\\/50')
    await expect(bubbleContainer).not.toBeVisible()
  })

  test('task creation works normally without AI enrichment', async ({
    authenticatedPage: page,
  }) => {
    const taskTitle = `E2E test task ${Date.now()}`

    // Use the quick-add input to create a task
    const quickAddInput = page.getByRole('textbox', { name: 'Quick add task' })
    await expect(quickAddInput).toBeVisible({ timeout: 5000 })
    await quickAddInput.fill(taskTitle)
    await quickAddInput.press('Enter')

    // The new task should appear in the task list
    await expect(page.getByText(taskTitle)).toBeVisible({ timeout: 10000 })
  })

  test('hamburger menu AI Status item does not show status dot when AI is disabled', async ({
    authenticatedPage: page,
  }) => {
    // Open the hamburger menu — this triggers a fetch to /api/ai/status
    await page.getByRole('button', { name: 'Menu' }).click()

    // Wait for the menu to render and the lazy AI status fetch to complete
    const aiStatusItem = page.getByRole('menuitem', { name: 'AI Status' })
    await expect(aiStatusItem).toBeVisible()

    // When AI is disabled (503 response), the AIStatusDot should not render.
    // The dot is a span with rounded-full class inside the AI Status menu item.
    // The handler sets aiSlotState to 'disabled', and the Header only renders
    // AIStatusDot when state !== 'disabled'.
    const dot = aiStatusItem.locator('span.rounded-full')
    await expect(dot).not.toBeVisible()
  })
})
