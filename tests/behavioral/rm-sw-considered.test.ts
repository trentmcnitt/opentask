/**
 * The service worker's "Considered" button (public/sw.js, review of #368).
 * sw.js runs in a sandbox with a fake `self`, `fetch` and registration; the
 * test dispatches the `notificationclick` the browser would and checks what
 * happens to the banner:
 *  - 200 `considered: true` or `considered: false`: closed;
 *  - 401, 5xx, a network error: replaced, same tag, silent, with
 *    "Couldn't mark it considered — open OpenTask"; never just closed;
 *  - the POST carries `day` (the push's `reminder_day`) and no navigation
 *    happens.
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

function click(listeners: Record<string, Listener>) {
  let pending: Promise<unknown> = Promise.resolve()
  const notification = {
    title: 'Synthetic reminder',
    tag: 'reminder-41',
    data: { taskId: 41, reminder_day: '2026-01-15', url: 'https://tasks.example/reminders' },
    close: vi.fn(),
  }
  listeners.notificationclick({
    action: 'considered',
    notification,
    waitUntil: (p: Promise<unknown>) => {
      pending = p
    },
  })
  return { notification, done: pending }
}

const answer = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('sw.js Considered', () => {
  test('considered: true closes the banner; the POST carries day; no navigation', async () => {
    const w = loadWorker(() => answer(200, { data: { considered: true } }))
    const { notification, done } = click(w.listeners)
    expect(notification.close).not.toHaveBeenCalled()
    await done
    expect(notification.close).toHaveBeenCalledTimes(1)
    expect(w.showNotification).not.toHaveBeenCalled()
    expect(w.openWindow).not.toHaveBeenCalled()
    const [url, init] = w.fetch.mock.calls[0]
    expect(url).toBe('/api/notifications/actions')
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'done',
      task_id: 41,
      day: '2026-01-15',
    })
  })

  test('considered: false (stale, or no longer waiting) just closes it', async () => {
    const w = loadWorker(() => answer(200, { data: { considered: false } }))
    const { notification, done } = click(w.listeners)
    await done
    expect(notification.close).toHaveBeenCalledTimes(1)
    expect(w.showNotification).not.toHaveBeenCalled()
  })

  test.each([
    ['a 401', () => answer(401, { error: 'Token required' })],
    ['a 403', () => answer(403, { error: 'Cross-site request refused' })],
    ['a 500', () => answer(500, { error: 'boom' })],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s replaces the banner (same tag, silent), never just closes it', async (_, reply) => {
    const w = loadWorker(reply)
    const { notification, done } = click(w.listeners)
    await done
    expect(notification.close).not.toHaveBeenCalled()
    expect(w.showNotification).toHaveBeenCalledWith('Synthetic reminder', {
      body: "Couldn't mark it considered — open OpenTask",
      icon: '/icon-192.png',
      data: { url: 'https://tasks.example/reminders', taskId: 41 },
      tag: 'reminder-41',
      silent: true,
    })
  })
})
