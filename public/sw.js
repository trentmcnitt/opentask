// OpenTask Service Worker - Minimal offline detection
// No mutation queuing, just detect offline and cache shell

// Extract build ID from registration URL (e.g., /sw.js?v=20260204-1430)
const buildId = new URL(self.location.href).searchParams.get('v') || 'v1'
const CACHE_NAME = `opentask-${buildId}`
const SHELL_URLS = ['/', '/manifest.json']

// Forward errors to the main thread for reporting via /api/errors/report
function forwardErrorToClients(message, stack) {
  self.clients.matchAll().then((windowClients) => {
    for (const client of windowClients) {
      client.postMessage({ type: 'sw_error', message, stack })
    }
  })
}

self.addEventListener('error', (event) => {
  forwardErrorToClients(event.message || 'Service worker error', event.error?.stack)
})

self.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  forwardErrorToClients(message, stack)
})

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))),
      ),
  )
  self.clients.claim()
})

// Web Push: show notification or handle dismiss when push message arrives.
// Suppresses notifications when the app is already visible — the user is looking
// at their task list and doesn't need push banners. This also prevents notification
// bombardment: when the cron sends 20 notifications in sequence and the user taps the
// first one (opening the app), the remaining notifications are silently discarded.
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {}

  // Dismiss-all signal: close every notification (user opened the app on another device)
  if (data.type === 'dismiss-all') {
    event.waitUntil(
      self.registration.getNotifications().then((notifications) => {
        notifications.forEach((n) => n.close())
      }),
    )
    return
  }

  // Dismiss signal: close matching notifications instead of showing a new one
  if (data.type === 'dismiss') {
    event.waitUntil(handleDismiss(data.taskIds || [], data.promptKeys || []))
    return
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const hasFocusedClient = windowClients.some((c) => c.visibilityState === 'visible')

      if (hasFocusedClient && !data.test) {
        // App is open and visible — skip the notification.
        // Having a visible client satisfies the browser's push event requirement.
        // Test notifications (data.test=true) bypass this so the user sees them immediately.
        return
      }

      return self.registration.showNotification(data.title || 'OpenTask', {
        body: data.body || '',
        icon: '/icon-192.png',
        data: data.data || {},
        tag: data.tag || undefined,
        // Quiet pushes (the "AI finished" notification) ask for no sound or
        // vibration. Everything else keeps the platform default.
        silent: data.silent === true,
        // A repeat that REPLACES a tagged banner (an overdue nag, tag = its
        // APNs collapse id) alerts again only with `renotify`. The browser
        // throws a TypeError for renotify without a tag, or with silent.
        renotify: Boolean(data.tag) && data.renotify === true && data.silent !== true,
        // Buttons: the named reminder push's "Considered" (2026-10-26) and
        // the named quota-prompt push's "Considered" and "Did it" (Push PR 4),
        // handled in `notificationclick` below.
        actions: Array.isArray(data.actions) ? data.actions : undefined,
      })
    }),
  )
})

/** A named quota-prompt banner's key: its tag `prompt-<key>`, else its data's `prompt_key`. */
function promptKeyOf(notification) {
  const tag = notification.tag
  if (typeof tag === 'string' && tag.startsWith('prompt-')) return tag.slice('prompt-'.length)
  const key = notification.data?.prompt_key
  return typeof key === 'string' ? key : null
}

/**
 * Close notifications matching the given task IDs.
 * Used for cross-device dismissal — when a task is done/snoozed on one device,
 * the notification disappears from all other devices.
 *
 * With `promptKeys` (a named quota-prompt push ended, review of #377) the
 * dismiss is prompt-precise: a prompt banner closes only when its key is
 * listed — so considering Morning's prompt of a daily quota leaves Evening's
 * banner — and every other banner by `taskIds` as before. Without them,
 * `taskIds` closes every banner of those tasks, prompt banners included (a
 * quota deleted or done).
 */
async function handleDismiss(taskIds, promptKeys) {
  const notifications = await self.registration.getNotifications()
  const taskIdSet = new Set(taskIds)
  const promptKeySet = new Set(promptKeys)
  let closed = 0

  for (const notification of notifications) {
    const promptKey = promptKeyOf(notification)
    const match =
      promptKeySet.size > 0 && promptKey !== null
        ? promptKeySet.has(promptKey)
        : Boolean(notification.data?.taskId) && taskIdSet.has(notification.data.taskId)
    if (match) {
      notification.close()
      closed++
    }
  }

  // If the PWA is focused, or we closed at least one notification, we're good.
  // The browser requires showNotification in response to a push event, but closing
  // an existing notification satisfies this in practice. If neither condition is met,
  // the browser may show a generic "site updated in background" message — acceptable
  // since this device didn't have a notification for this task anyway.
  if (closed === 0) {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const hasFocusedClient = windowClients.some((c) => c.visibilityState === 'visible')
    if (!hasFocusedClient) {
      // No notification to close and no focused client — show a silent notification
      // that auto-closes to satisfy the browser requirement
      await self.registration.showNotification('OpenTask', {
        body: 'Task updated',
        icon: '/icon-192.png',
        tag: 'dismiss-ack',
        silent: true,
      })
    }
  }
}

// Web Push: handle notification tap — open or focus the PWA at the target URL.
// Also clears all remaining delivered notifications since the user is now in the app.
/**
 * The named reminder push's "Considered" button (2026-10-26): consider the
 * reminder in the background — no navigation, the other banners stay. It
 * sends the push's `reminder_day` as `day`, so the server changes nothing for
 * another day's push or a reminder no longer waiting (200 `considered:
 * false`). Authenticated by the session cookie; the route refuses a cookie
 * POST that isn't same-origin (CSRF, 403), and this same-origin fetch carries
 * `Sec-Fetch-Site: same-origin` and the app's `Origin`.
 *
 * The banner stays up until the server answers (review of #368: with the app
 * closed, a failure would otherwise vanish unseen):
 *  - 2xx and `considered: true`, or `considered: false` (stale, or no longer
 *    waiting — nothing to do): close it;
 *  - anything else — 401/403, 5xx, a network error: replace it (same tag,
 *    silent) with "Couldn't mark it considered — open OpenTask", whose tap
 *    opens the app like any banner.
 */
async function considerFromBanner(notification) {
  const data = notification.data || {}
  let answer = null
  try {
    const res = await fetch('/api/notifications/actions', {
      method: 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'done', task_id: data.taskId, day: data.reminder_day }),
    })
    if (res.ok) answer = (await res.json())?.data ?? null
  } catch (err) {
    forwardErrorToClients(`Considered failed: ${err}`, err?.stack)
  }
  if (answer && typeof answer.considered === 'boolean') {
    notification.close()
    return
  }
  await self.registration.showNotification(notification.title || 'OpenTask', {
    body: "Couldn't mark it considered — open OpenTask",
    icon: '/icon-192.png',
    data: { url: data.url || '/', taskId: data.taskId },
    tag: notification.tag || undefined,
    silent: true,
  })
}

/**
 * The named quota-prompt push's buttons (Push PR 4, 2026-10-26): "Considered"
 * POSTs /api/quota-prompts/consider, "Did it" /api/quota-prompts/did, each
 * with the push's `prompt_key` — in the background, no navigation, the other
 * banners stay. Both routes are idempotent per key. Authenticated by the
 * session cookie; like the actions route, they refuse a cookie POST that
 * isn't same-origin (403), and this same-origin fetch says it is.
 *
 * The banner stays up until the server answers, as for a reminder's
 * Considered (review of #368):
 *  - 2xx: done (or already done) — close it;
 *  - 400: this worker always sends a well-formed body, so a 400 is the
 *    server refusing the KEY: another day's (the push outlived its OpenTask
 *    day) or a quota no longer the user's live one. "Considered" closes it
 *    quietly — nothing to consider. "Did it" replaces it (same tag, silent)
 *    with "That was yesterday's — open OpenTask to log it" (review of #377):
 *    the user did the thing, and the count it should add is not logged;
 *  - anything else — 401/403, 5xx, a network error: replace it (same tag,
 *    silent) with "Couldn't … — open OpenTask", whose tap opens the app.
 */
const PROMPT_ACTIONS = {
  considered: { path: '/api/quota-prompts/consider', failed: "Couldn't mark it considered" },
  did: { path: '/api/quota-prompts/did', failed: "Couldn't log it" },
}

async function actOnPromptFromBanner(notification, action) {
  const data = notification.data || {}
  const { path, failed } = PROMPT_ACTIONS[action]
  let status = 0
  try {
    const res = await fetch(path, {
      method: 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        action === 'did' ? { keys: [data.prompt_key], source: 'web' } : { keys: [data.prompt_key] },
      ),
    })
    status = res.status
  } catch (err) {
    forwardErrorToClients(`Prompt ${action} failed: ${err}`, err?.stack)
  }
  if ((status >= 200 && status < 300) || (status === 400 && action === 'considered')) {
    notification.close()
    return
  }
  await self.registration.showNotification(notification.title || 'OpenTask', {
    body:
      status === 400
        ? "That was yesterday's — open OpenTask to log it"
        : `${failed} — open OpenTask`,
    icon: '/icon-192.png',
    data: { url: data.url || '/', taskId: data.taskId, prompt_key: data.prompt_key },
    tag: notification.tag || undefined,
    silent: true,
  })
}

self.addEventListener('notificationclick', (event) => {
  // A quota prompt's banner (it carries `prompt_key`): its own two buttons.
  if (
    (event.action === 'considered' || event.action === 'did') &&
    typeof event.notification.data?.prompt_key === 'string'
  ) {
    event.waitUntil(actOnPromptFromBanner(event.notification, event.action))
    return
  }
  if (event.action === 'considered' || event.action === 'did') {
    if (event.action === 'did' || typeof event.notification.data?.taskId !== 'number') {
      event.notification.close()
      return
    }
    event.waitUntil(considerFromBanner(event.notification))
    return
  }

  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    // Clear all remaining OpenTask notifications — the user is opening the app
    self.registration
      .getNotifications()
      .then((notifications) => {
        notifications.forEach((n) => n.close())
      })
      .then(() => clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            client.navigate(url)
            return client.focus()
          }
        }
        return clients.openWindow(url)
      }),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Cache-first for Next.js static assets (content-hashed, immutable)
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return response
        })
      }),
    )
    return
  }

  // Navigation: network-first with offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/').then((r) => r || new Response('Offline', { status: 503 })),
      ),
    )
  }
})
