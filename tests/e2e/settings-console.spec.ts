/**
 * Settings → Default period stays a controlled Select while its prefs load.
 *
 * The picker mounts once the periods have loaded, but its value comes from a
 * separate GET /api/user/preferences (`useQuotaPromptPrefs`). It used to be
 * `undefined` until that answered and an id after, so Radix logged "Select is
 * changing from uncontrolled to controlled" whenever the periods won the race
 * (seen in WebKit on prod). Here the preferences GET is held until the picker
 * is on screen, which makes that ordering certain rather than a race.
 */
import { test, expect } from './fixtures'

test('Default period picker: no uncontrolled → controlled warning', async ({
  authenticatedPage: page,
}) => {
  const warnings: string[] = []
  page.on('console', (msg) => {
    if (msg.text().includes('changing from uncontrolled to controlled')) warnings.push(msg.text())
  })

  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/user/preferences', async (route) => {
    if (route.request().method() === 'GET') await released
    await route.continue()
  })

  await page.goto('/settings')
  const picker = page.locator('[data-default-reminder-slot]')
  await expect(picker).toBeVisible()
  await expect(picker).toContainText('Choose a period')

  // Let the prefs through; the picker then shows the resolved period.
  const prefsLoaded = page.waitForResponse(
    (res) => res.url().endsWith('/api/user/preferences') && res.request().method() === 'GET',
  )
  release()
  await prefsLoaded
  await expect(picker).not.toContainText('Choose a period')

  // Radix warns from an effect after that render. Console messages arrive in
  // order, so once a marker logged afterwards has arrived, any warning has too.
  const marker = page.waitForEvent('console', (msg) => msg.text() === 'settings-console-marker')
  await page.evaluate(() => console.log('settings-console-marker'))
  await marker

  expect(warnings).toEqual([])
})
