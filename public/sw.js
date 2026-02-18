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

// Web Push: show notification when push message arrives
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'OpenTask', {
      body: data.body || '',
      icon: '/icon-192.png',
      data: data.data || {},
      tag: data.tag || undefined,
    }),
  )
})

// Web Push: handle notification tap — open or focus the PWA at the target URL
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
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
