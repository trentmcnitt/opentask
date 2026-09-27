/**
 * APNs environment fallback (2026-09-27).
 *
 * A Release iOS build installed straight to a device is signed with
 * `aps-environment: development` (sandbox tokens) but registered itself as
 * "production". APNs answers BadDeviceToken for a sandbox token on the
 * production host, and the server used to delete the registration — push
 * silently stopped. Now a BadDeviceToken is retried once on the other
 * environment; success corrects the stored environment, failure on both
 * still removes the token.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

// Which host accepts which token: token → the environment APNs knows it in.
const tokenHome = new Map<string, 'development' | 'production'>()

vi.mock('fs', async (orig) => ({
  ...(await orig<typeof import('fs')>()),
  readFileSync: vi.fn(() => 'fake-key'),
}))

vi.mock('apns2', async (orig) => {
  const real = await orig<typeof import('apns2')>()
  class FakeClient {
    host: string
    constructor(opts: { host: string }) {
      this.host = opts.host
    }
    async send(n: { deviceToken: string }) {
      const env = this.host === real.Host.development ? 'development' : 'production'
      const home = tokenHome.get(n.deviceToken)
      if (home !== env) {
        throw { reason: home ? real.Errors.badDeviceToken : real.Errors.unregistered }
      }
    }
  }
  return { ...real, ApnsClient: FakeClient }
})

process.env.APNS_KEY_ID = 'K'
process.env.APNS_TEAM_ID = 'T'
process.env.APNS_KEY_PATH = '/fake.p8'
process.env.APNS_BUNDLE_ID = 'io.mcnitt.opentask'

const { getDb, resetDb } = await import('@/core/db')
const { sendApnsBadgeUpdate } = await import('@/core/notifications/apns')
const { setupTestDb, TEST_USER_ID } = await import('../helpers/setup')

function addDevice(token: string, environment: string) {
  getDb()
    .prepare(
      'INSERT INTO apns_devices (user_id, device_token, bundle_id, environment) VALUES (?, ?, ?, ?)',
    )
    .run(TEST_USER_ID, token, 'io.mcnitt.opentask', environment)
}

function deviceEnv(token: string): string | undefined {
  const row = getDb()
    .prepare('SELECT environment FROM apns_devices WHERE device_token = ?')
    .get(token) as { environment: string } | undefined
  return row?.environment
}

describe('APNs environment fallback', () => {
  beforeEach(() => {
    setupTestDb()
    tokenHome.clear()
  })
  afterEach(() => resetDb())

  test('a sandbox token registered as production is kept and corrected', async () => {
    tokenHome.set('sandbox-token', 'development')
    addDevice('sandbox-token', 'production')

    await sendApnsBadgeUpdate(TEST_USER_ID, 3)

    expect(deviceEnv('sandbox-token')).toBe('development')
  })

  test('a production token registered as development is corrected the other way', async () => {
    tokenHome.set('prod-token', 'production')
    addDevice('prod-token', 'development')

    await sendApnsBadgeUpdate(TEST_USER_ID, 3)

    expect(deviceEnv('prod-token')).toBe('production')
  })

  test('a correctly registered token is left alone', async () => {
    tokenHome.set('ok-token', 'production')
    addDevice('ok-token', 'production')

    await sendApnsBadgeUpdate(TEST_USER_ID, 3)

    expect(deviceEnv('ok-token')).toBe('production')
  })

  test('a token APNs knows in neither environment is still removed', async () => {
    addDevice('dead-token', 'production')

    await sendApnsBadgeUpdate(TEST_USER_ID, 3)

    expect(deviceEnv('dead-token')).toBeUndefined()
  })
})
