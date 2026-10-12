'use client'

import { useEffect } from 'react'
import { isChunkLoadError, reloadOnceForChunkError } from '@/lib/chunk-error'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // A deploy swapped the app's files under this page: reload into the new
    // build instead of showing the error (src/lib/chunk-error.ts).
    if (reloadOnceForChunkError(error)) return
    fetch('/api/errors/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'react_error',
        message: `Root layout crash: ${error.message}`,
        stack: error.stack,
        url: window.location.href,
      }),
    }).catch(() => {})
  }, [error])

  return (
    <html lang="en">
      <body>
        <div
          style={{
            display: 'flex',
            minHeight: '100vh',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <h2 style={{ marginBottom: '8px', fontSize: '18px', fontWeight: 600 }}>
              Something went wrong
            </h2>
            <p style={{ marginBottom: '16px', fontSize: '14px', color: '#71717a' }}>
              {error.message || 'An unexpected error occurred'}
            </p>
            <button
              onClick={() => (isChunkLoadError(error) ? window.location.reload() : reset())}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                borderRadius: '8px',
                border: 'none',
                backgroundColor: '#f4f4f5',
                cursor: 'pointer',
              }}
            >
              Try Again
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
