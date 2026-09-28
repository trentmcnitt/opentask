/**
 * Two small guards for the "refetch everything" paths (dashboard task list,
 * Reminders panel, Track panel, task detail).
 *
 * Both exist because a surface can be asked to refresh from several places at
 * once — a sync-stream event, the tab becoming visible, the window regaining
 * focus, the network coming back, the native app telling the page it is
 * active again — and those triggers overlap.
 */

/**
 * How recently a full refresh must have STARTED for a resume trigger (window
 * `focus`, `online`, the native `opentask-app-active` event, the tab becoming
 * visible) to skip its own.
 *
 * This is a deduplication rule, not a timing workaround: coming back to the
 * app typically fires two or three of those triggers within the same moment
 * (on iOS, visibilitychange AND the native event; in a browser tab,
 * visibilitychange AND focus), and a refresh that started a few seconds ago
 * already reads the server state they are all asking for. Server-driven sync
 * events are NOT subject to it — they mean something actually changed.
 */
export const RESUME_REFRESH_DEDUPE_MS = 3000

/**
 * Whether a resume trigger should run a full refresh, given when the last one
 * started (`null` = none has run in this page yet).
 */
export function shouldResumeRefresh(
  lastStartedAt: number | null,
  now: number,
  windowMs: number = RESUME_REFRESH_DEDUPE_MS,
): boolean {
  if (lastStartedAt === null) return true
  // A clock that went backwards (manual change, NTP step) must not suppress
  // refreshes until it catches up again.
  if (now < lastStartedAt) return true
  return now - lastStartedAt >= windowMs
}

/**
 * Drops responses that arrive after a newer request for the same data was
 * sent. Without it, two overlapping refreshes (say, a focus refresh and a
 * sync-event refresh) can resolve out of order, and the older payload —
 * possibly from before a change on another device — overwrites the newer one
 * and sticks until the next refresh.
 *
 * Usage: `const seq = guard.begin()` before the fetch; after the response is
 * parsed, apply it only if `guard.isLatest(seq)`.
 */
export interface LatestRequestGuard {
  begin(): number
  isLatest(seq: number): boolean
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let latest = 0
  return {
    begin() {
      latest += 1
      return latest
    },
    isLatest(seq) {
      return seq === latest
    },
  }
}
