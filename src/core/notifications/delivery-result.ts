/**
 * What one push's delivery came to, across its devices or subscriptions —
 * so the minute's tick can tell a lead that reached nobody (tick.ts: the
 * next send that would sound is promoted and alerts instead).
 *
 * `attempted` counts the endpoints a push was sent to, `delivered` the ones
 * that took it. A channel that is off, or a user with nothing registered on
 * it, attempts nothing: that is not a failure. A stale token or subscription
 * (removed on the spot) is attempted and not delivered.
 */
export interface DeliveryResult {
  attempted: number
  delivered: number
}

/** Nothing sent: the channel is off or the user has nothing registered on it. */
export const NOTHING_SENT: DeliveryResult = { attempted: 0, delivered: 0 }

/** The sum of several channels' results. A missing one (a mocked sender) counts as nothing sent. */
export function mergeDeliveries(results: (DeliveryResult | void | undefined)[]): DeliveryResult {
  return results.reduce<DeliveryResult>(
    (sum, r) => ({
      attempted: sum.attempted + (r?.attempted ?? 0),
      delivered: sum.delivered + (r?.delivered ?? 0),
    }),
    NOTHING_SENT,
  )
}

/** Settled sends' results merged; a rejected send counts as one attempt that failed. */
export function mergeSettled(
  results: PromiseSettledResult<DeliveryResult | void | undefined>[],
): DeliveryResult {
  return mergeDeliveries(
    results.map((r) => (r.status === 'fulfilled' ? r.value : { attempted: 1, delivered: 0 })),
  )
}

/** It was sent somewhere and reached nothing: every channel failed. */
export function deliveryFailed(result: DeliveryResult | void | undefined): boolean {
  return result !== undefined && result.attempted > 0 && result.delivered === 0
}
