// OpenTask Service Worker - Minimal offline detection
// No mutation queuing, just detect offline and cache shell

// Extract build ID from registration URL (e.g., /sw.js?v=20260204-1430)
const buildId = new URL(self.location.href).searchParams.get('v') || 'v1'
const CACHE_NAME = `opentask-${buildId}`
const SHELL_URLS = ['/', '/manifest.json']

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

  // Dismiss signal: close matching notifications instead of showing a new one
  if (data.type === 'dismiss') {
    event.waitUntil(handleDismiss(data.taskIds || []))
    return
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const hasFocusedClient = windowClients.some((c) => c.visibilityState === 'visible')

      if (hasFocusedClient) {
        // App is open and visible — skip the notification.
        // Having a visible client satisfies the browser's push event requirement.
        return
      }

      return self.registration.showNotification(data.title || 'OpenTask', {
        body: data.body || '',
        icon: '/icon-192.png',
        data: data.data || {},
        tag: data.tag || undefined,
      })
    }),
  )
})

/**
 * Close notifications matching the given task IDs.
 * Used for cross-device dismissal — when a task is done/snoozed on one device,
 * the notification disappears from all other devices.
 */
async function handleDismiss(taskIds) {
  const notifications = await self.registration.getNotifications()
  const taskIdSet = new Set(taskIds)
  let closed = 0

  for (const notification of notifications) {
    if (notification.data?.taskId && taskIdSet.has(notification.data.taskId)) {
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
self.addEventListener('notificationclick', (event) => {
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
  // Only handle navigation requests with cache fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/').then((r) => r || new Response('Offline', { status: 503 })),
      ),
    )
  }
})
