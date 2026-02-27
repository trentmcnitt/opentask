/**
 * Client-side instrumentation — runs before the app becomes interactive.
 *
 * Sets up global error handlers that report uncaught exceptions and
 * unhandled promise rejections to the server via /api/errors/report.
 * These catch errors that React error boundaries miss: event handlers,
 * async callbacks, third-party scripts, setTimeout/setInterval.
 */

function reportError(
  type: 'js_error' | 'promise_rejection' | 'sw_error',
  message: string,
  stack?: string,
): void {
  // Fire-and-forget — never block the UI
  fetch('/api/errors/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type,
      message,
      stack,
      url: window.location.href,
    }),
  }).catch(() => {})
}

window.addEventListener('error', (event) => {
  // Ignore errors from cross-origin scripts (no useful info)
  if (!event.message || event.message === 'Script error.') return

  reportError('js_error', event.message, event.error?.stack)
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined

  reportError('promise_rejection', message, stack)
})

// Listen for errors forwarded from the service worker
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'sw_error') {
    reportError('sw_error', event.data.message, event.data.stack)
  }
})
