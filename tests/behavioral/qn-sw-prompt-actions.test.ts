/**
 * The named quota-prompt push's buttons in the service worker (public/sw.js,
 * Push PR 4). sw.js runs in a sandbox with a fake `self`, `fetch` and
 * registration, as in rm-sw-considered.test.ts; the test dispatches the
 * `notificationclick` the browser would and checks the call and the banner:
 *  - "Considered" POSTs /api/quota-prompts/consider, "Did it"
 *    /api/quota-prompts/did, each with `{ keys: [prompt_key] }` (did it also
 *    says `source: 'web'`), and no navigation happens;
 *  - 200: closed; 400 (another day's key — sw.js sends a well-formed body,
 *    so a 400 is the key refused): Considered closes quietly, Did it is
 *    replaced with "That was yesterday's — open OpenTask to log it" (review
 *    of #377);
 *  - 401, 403, 5xx, a network error: replaced, same tag, silent, with
 *    "Couldn't … — open OpenTask"; never just closed;
 *  - a reminder's banner (no `prompt_key`) still takes the reminder path;
 *  - a `dismiss` push with `promptKeys` closes only the listed prompt
 *    banners (by tag), and other banners by `taskIds`; without them,
 *    `taskIds` closes prompt banners too.
 * Synthetic data only.
 */
import { describe, test, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import vm from 'vm'

const SW = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8')

type Listener = (event: unknown) => void

function loadWorker(fetchImpl: (url: string, init: RequestInit) => Promise<unknown>) {
  const listeners: Record<string, Listener> = {}
  const showNotification = vi.fn(async () => {})
  const openWindow = vi.fn()
  const fetch = vi.fn(fetchImpl)
  const self = {
    location: { href: 'https://tasks.example/sw.js?v=test' },
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn
    },
    registration: { showNotification, getNotifications: async () => [] },
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
  }
  vm.runInNewContext(SW, {
    self,
    clients: { matchAll: async () => [], openWindow },
    caches: {},
    fetch,
    URL,
    JSON,
    console,
  })
  return { listeners, showNotification, openWindow, fetch }
}

const KEY = 'q:41:0:2026-01-15'
const URL_TO_ROW = `https://tasks.example/reminders?prompt=${encodeURIComponent(KEY)}`

function click(listeners: Record<string, Listener>, action: string, data?: unknown) {
  let pending: Promise<unknown> = Promise.resolve()
  const notification = {
    title: 'Synthetic quota',
    tag: `prompt-${KEY}`,
    data: data ?? { taskId: 41, prompt_key: KEY, url: URL_TO_ROW },
    close: vi.fn(),
  }
  listeners.notificationclick({
    action,
    notification,
    waitUntil: (p: Promise<unknown>) => {
      pending = p
    },
  })
  return { notification, done: pending }
}

const answer = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })

describe.each([
  ['considered', '/api/quota-prompts/consider', { keys: [KEY] }, "Couldn't mark it considered"],
  ['did', '/api/quota-prompts/did', { keys: [KEY], source: 'web' }, "Couldn't log it"],
])('sw.js prompt %s', (action, route, body, failed) => {
  test('200 closes the banner; the POST carries the key; no navigation', async () => {
    const w = loadWorker(() => answer(200, { data: { considered: 1, did: 0, tasks: [] } }))
    const { notification, done } = click(w.listeners, action)
    expect(notification.close).not.toHaveBeenCalled()
    await done
    expect(notification.close).toHaveBeenCalledTimes(1)
    expect(w.showNotification).not.toHaveBeenCalled()
    expect(w.openWindow).not.toHaveBeenCalled()
    const [url, init] = w.fetch.mock.calls[0]
    expect(url).toBe(route)
    expect(init).toMatchObject({ method: 'POST', mode: 'same-origin', credentials: 'same-origin' })
    expect(JSON.parse(init.body as string)).toEqual(body)
  })

  test('400 (another day’s key): Considered closes quietly; Did it says it was yesterday’s', async () => {
    const w = loadWorker(() => answer(400, { error: 'Invalid or stale prompt keys' }))
    const { notification, done } = click(w.listeners, action)
    await done
    if (action === 'considered') {
      expect(notification.close).toHaveBeenCalledTimes(1)
      expect(w.showNotification).not.toHaveBeenCalled()
      return
    }
    expect(notification.close).not.toHaveBeenCalled()
    expect(w.showNotification).toHaveBeenCalledWith('Synthetic quota', {
      body: "That was yesterday's — open OpenTask to log it",
      icon: '/icon-192.png',
      data: { url: URL_TO_ROW, taskId: 41, prompt_key: KEY },
      tag: `prompt-${KEY}`,
      silent: true,
    })
  })

  test.each([
    ['a 401', () => answer(401, { error: 'Unauthorized' })],
    ['a 403', () => answer(403, { error: 'Cross-site request refused' })],
    ['a 500', () => answer(500, { error: 'boom' })],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s replaces the banner (same tag, silent), never just closes it', async (_, reply) => {
    const w = loadWorker(reply)
    const { notification, done } = click(w.listeners, action)
    await done
    expect(notification.close).not.toHaveBeenCalled()
    expect(w.showNotification).toHaveBeenCalledWith('Synthetic quota', {
      body: `${failed} — open OpenTask`,
      icon: '/icon-192.png',
      data: { url: URL_TO_ROW, taskId: 41, prompt_key: KEY },
      tag: `prompt-${KEY}`,
      silent: true,
    })
  })
})

describe('sw.js: a reminder banner keeps its own path', () => {
  test('Considered without a prompt_key goes to the actions route with day', async () => {
    const w = loadWorker(() => answer(200, { data: { considered: true } }))
    const { done } = click(w.listeners, 'considered', {
      taskId: 7,
      reminder_day: '2026-01-15',
      url: 'https://tasks.example/reminders',
    })
    await done
    const [url, init] = w.fetch.mock.calls[0]
    expect(url).toBe('/api/notifications/actions')
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'done',
      task_id: 7,
      day: '2026-01-15',
    })
  })

  test('"did" on a banner without a prompt_key does nothing but close it', async () => {
    const w = loadWorker(() => answer(200, {}))
    const { notification } = click(w.listeners, 'did', { taskId: 7 })
    expect(notification.close).toHaveBeenCalledTimes(1)
    expect(w.fetch).not.toHaveBeenCalled()
  })
})

/** The `dismiss` push (push event) against a set of delivered banners. */
async function dismiss(payload: unknown, banners: { tag?: string; data?: unknown }[]) {
  const listeners: Record<string, Listener> = {}
  const delivered = banners.map((b) => ({ ...b, close: vi.fn() }))
  const self = {
    location: { href: 'https://tasks.example/sw.js?v=test' },
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn
    },
    registration: {
      showNotification: vi.fn(async () => {}),
      getNotifications: async () => delivered,
    },
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
  }
  vm.runInNewContext(SW, {
    self,
    clients: { matchAll: async () => [] },
    caches: {},
    fetch: vi.fn(),
    URL,
    JSON,
    console,
  })
  let pending: Promise<unknown> = Promise.resolve()
  listeners.push({
    data: { json: () => payload },
    waitUntil: (p: Promise<unknown>) => {
      pending = p
    },
  })
  await pending
  return delivered.map((b) => b.close.mock.calls.length > 0)
}

describe('sw.js dismiss: prompt banners by prompt key (review of #377)', () => {
  const MORNING = 'q:41:1:2026-01-15'
  const EVENING = 'q:41:2:2026-01-15'
  const banners = [
    { tag: `prompt-${MORNING}`, data: { taskId: 41, prompt_key: MORNING } },
    { tag: `prompt-${EVENING}`, data: { taskId: 41, prompt_key: EVENING } },
    { tag: 'enriched-41', data: { taskId: 41 } },
    { tag: 'task-7', data: { taskId: 7 } },
  ]

  test('with promptKeys: only the listed prompt banner, plus non-prompt banners by taskId', async () => {
    expect(
      await dismiss({ type: 'dismiss', taskIds: [41], promptKeys: [MORNING] }, banners),
    ).toEqual([true, false, true, false])
  })

  test('a prompt banner is matched by its tag when its data has no key', async () => {
    expect(
      await dismiss({ type: 'dismiss', taskIds: [41], promptKeys: [EVENING] }, [
        { tag: `prompt-${EVENING}`, data: { taskId: 41 } },
        { tag: `prompt-${MORNING}`, data: { taskId: 41 } },
      ]),
    ).toEqual([true, false])
  })

  test('without promptKeys: taskIds closes every banner of the task, prompt banners included', async () => {
    expect(await dismiss({ type: 'dismiss', taskIds: [41] }, banners)).toEqual([
      true,
      true,
      true,
      false,
    ])
  })
})
