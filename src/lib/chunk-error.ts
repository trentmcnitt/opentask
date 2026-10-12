/**
 * A deploy replaces the app's script chunks. A page loaded before it (a tab
 * left open, the native apps' web views) still asks for the old ones, and if
 * one of them is missing — during the deploy's file swap, or an old build's
 * chunk that no longer exists — the import fails with "Failed to load chunk"
 * / ChunkLoadError. React's `reset()` can't recover from that: the module
 * loader remembers the failure. Only a full reload fetches the new build.
 *
 * So the error boundaries reload ONCE on their own for a chunk error, and
 * their "Try Again" reloads too. The once-guard (per tab, per minute) stops a
 * reload loop if the new build itself were broken: the second failure shows
 * the error page instead.
 */
const GUARD_KEY = 'opentask:chunk-reload-at'
const GUARD_MS = 60_000

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.name === 'ChunkLoadError' ||
    /Failed to load chunk|Loading chunk [\w-]+ failed|Loading CSS chunk/i.test(error.message)
  )
}

/** Reload for a chunk error unless this tab already did in the last minute. */
export function reloadOnceForChunkError(error: unknown): boolean {
  if (!isChunkLoadError(error)) return false
  try {
    const last = Number(sessionStorage.getItem(GUARD_KEY) ?? 0)
    if (Date.now() - last < GUARD_MS) return false
    sessionStorage.setItem(GUARD_KEY, String(Date.now()))
  } catch {
    // No storage (private mode, a sandboxed view): reload anyway — at worst the
    // page shows the error after the reload if the new build is broken too.
  }
  window.location.reload()
  return true
}
