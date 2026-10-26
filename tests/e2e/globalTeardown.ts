/**
 * Global teardown for E2E: put the server's real clock back.
 *
 * tests/e2e/tq-late-night.spec.ts pins the server's clock (POST
 * /api/test/clock, test mode only; src/core/test-clock.ts) and resets it in
 * its own afterAll. A spec that dies before its afterAll (a crashed worker)
 * would leave the server shifted, so the suite resets it here as well. The
 * web server is still up when global teardown runs. Best effort: a server
 * that has already gone has no clock to reset.
 */

export default async function globalTeardown() {
  const port = Number(process.env.E2E_PORT ?? 3333)
  try {
    await fetch(`http://localhost:${port}/api/test/clock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ now: null }),
    })
  } catch {
    // The server is gone: nothing is shifted.
  }
}
