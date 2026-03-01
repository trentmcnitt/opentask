/**
 * Load time performance measurement script
 *
 * Captures baseline metrics for dashboard load performance.
 * Run before and after optimizations to quantify improvement.
 *
 * Usage:
 *   npx playwright test tests/perf/load-time.spec.ts
 *
 * Results are printed to stdout and saved to .tmp/perf-baseline.json
 */

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const USERNAME = 'Test User'
const PASSWORD = 'testpass123'

test('measure dashboard load performance', async ({ page }) => {
  // Login
  await page.goto('/login')
  await page.getByLabel('Username').fill(USERNAME)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })

  // Wait for tasks to appear (confirms data is loaded and rendered)
  await page.waitForSelector('[id^="task-row-"], .text-4xl', { timeout: 15_000 })

  // Collect performance metrics
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
    const paints = performance.getEntriesByType('paint')
    const fcp = paints.find((p) => p.name === 'first-contentful-paint')

    // LCP via PerformanceObserver may not be available synchronously — use paint entries
    const lcp = paints.find((p) => p.name === 'largest-contentful-paint')

    // Resource summary
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const jsResources = resources.filter((r) => r.name.endsWith('.js'))
    const cssResources = resources.filter((r) => r.name.endsWith('.css'))

    return {
      ttfb: Math.round(nav.responseStart - nav.requestStart),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
      loadComplete: Math.round(nav.loadEventEnd - nav.startTime),
      fcp: fcp ? Math.round(fcp.startTime) : null,
      lcp: lcp ? Math.round(lcp.startTime) : null,
      resourceCount: resources.length,
      jsCount: jsResources.length,
      cssCount: cssResources.length,
      totalTransferSize: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
      jsTransferSize: jsResources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
    }
  })

  // Print results
  console.log('\n=== Dashboard Load Performance ===')
  console.log(`  TTFB:                ${metrics.ttfb}ms`)
  console.log(`  DOM Content Loaded:  ${metrics.domContentLoaded}ms`)
  console.log(`  Load Complete:       ${metrics.loadComplete}ms`)
  console.log(`  First Contentful Paint: ${metrics.fcp ?? 'N/A'}ms`)
  console.log(`  Largest Contentful Paint: ${metrics.lcp ?? 'N/A'}ms`)
  console.log(
    `  Resources:           ${metrics.resourceCount} total (${metrics.jsCount} JS, ${metrics.cssCount} CSS)`,
  )
  console.log(`  Total Transfer:      ${(metrics.totalTransferSize / 1024).toFixed(1)}KB`)
  console.log(`  JS Transfer:         ${(metrics.jsTransferSize / 1024).toFixed(1)}KB`)
  console.log('===================================\n')

  // Save to file
  const outDir = join(process.cwd(), '.tmp')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, 'perf-baseline.json')
  writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), metrics }, null, 2))
  console.log(`Results saved to ${outPath}`)

  // Basic sanity checks
  expect(metrics.ttfb).toBeGreaterThan(0)
  expect(metrics.domContentLoaded).toBeGreaterThan(0)
})
