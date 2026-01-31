import { test, expect } from '@playwright/test'

test.describe('Authentication', () => {
  test('login with valid credentials redirects to dashboard; invalid shows error', async ({ page }) => {
    // Try invalid credentials first
    await page.goto('/login')
    await page.getByLabel('Email').fill('wrong@example.com')
    await page.getByLabel('Password').fill('wrongpassword')
    await page.getByRole('button', { name: /sign in/i }).click()

    // Should show error message
    await expect(page.getByText('Invalid email or password')).toBeVisible({ timeout: 5000 })

    // Now try valid credentials
    await page.getByLabel('Email').fill('test@opentask.local')
    await page.getByLabel('Password').fill('testpass123')
    await page.getByRole('button', { name: /sign in/i }).click()

    // Should redirect to dashboard
    await page.waitForURL('/', { timeout: 10_000 })
    await expect(page.getByText('OpenTask')).toBeVisible()
  })
})
