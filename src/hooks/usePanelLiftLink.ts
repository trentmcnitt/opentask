'use client'

import { useCallback, useEffect, useState } from 'react'
import { LIFT_PARAMS, liftFromParams, type PanelLift } from '@/lib/panel-lift'

/**
 * A notification tap's lift for the dashboard's Reminders card
 * (src/lib/panel-lift.ts), from the URL (`?reminder=`, `?prompt=`, `?slot=`)
 * or from the `?task=` effect (a reminder).
 *
 * THE LIFT OUTLIVES A REMOUNT. The param is stripped from the URL as soon as
 * it is read, so a reload is a plain dashboard. On a fresh load the dashboard
 * can mount, read the param, unmount and mount again before the card has its
 * data (seen in E2E, about one load in four): a lift kept only in component
 * state was gone by then, and the card stayed on its natural page. So the
 * pending lift lives in this module until the card has applied it
 * (`consume`), and a remount picks it up again. Applied, it is component
 * state only: leaving the dashboard or reloading ends it.
 */
type Pending = { value: PanelLift; seq: number }
let pending: Pending | null = null
let seqCounter = 0

function setPending(value: PanelLift): Pending {
  seqCounter += 1
  pending = { value, seq: seqCounter }
  return pending
}

export function usePanelLiftLink(searchParams: { toString(): string }) {
  const [lift, setLift] = useState<Pending | null>(() => pending)

  // Read once per URL, during render (the params are the URL's; nothing to
  // wait for). `select` rides along on a redirected
  // `/reminders?reminder=<id>&select=1`; the card has no selection.
  const search = searchParams.toString()
  const [readSearch, setReadSearch] = useState<string | null>(null)
  if (search !== readSearch) {
    setReadSearch(search)
    const value = liftFromParams(new URLSearchParams(search))
    if (value && !(pending && sameLift(pending.value, value))) setLift(setPending(value))
  }
  // Stripped from the URL, so a reload is a plain dashboard.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!liftFromParams(params)) return
    for (const key of [...LIFT_PARAMS, 'select']) params.delete(key)
    const rest = params.toString()
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + (rest ? `?${rest}` : ''),
    )
  }, [search])

  /** A lift asked for in code: the `?task=` effect, when the task is a reminder. */
  const liftPanel = useCallback((value: PanelLift) => setLift(setPending(value)), [])

  /** The card has applied this lift: a remount from now on starts without it. */
  const consume = useCallback((seq: number) => {
    if (pending?.seq === seq) pending = null
  }, [])

  return { lift, liftPanel, consume }
}

/** The same lift (a re-render reading the same URL must not make a new one). */
function sameLift(a: PanelLift, b: PanelLift): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
