'use client'

import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    fetch('/api/errors/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'react_error',
        message: error.message,
        stack: error.stack,
        url: window.location.href,
      }),
    }).catch(() => {})
  }, [error])

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h2 className="mb-2 text-lg font-semibold">Something went wrong</h2>
        <p className="mb-4 text-sm text-zinc-500">
          {error.message || 'An unexpected error occurred'}
        </p>
        <button
          onClick={reset}
          className="rounded-lg bg-zinc-100 px-4 py-2 text-sm hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
        >
          Try Again
        </button>
      </div>
    </div>
  )
}
