'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'

/**
 * First-time guided tour for the public demo account.
 *
 * Rationale: visitors land on the demo with no signal that the quick-add box understands
 * natural language, or that tasks carry AI-generated urgency scores and commentary — it just
 * looks like a plain task list. This hook drives a short, one-time spotlight tour that points
 * at those specific elements (via `data-tour="..."` attributes rendered elsewhere) so a
 * first-time visitor sees the AI capability instead of having to discover it. `DemoTour.tsx`
 * is the presentational half — it renders whatever this hook reports.
 *
 * Persistence is `localStorage`, not a cookie: the tour is a pure client-side "have I seen
 * this before" flag with nothing the server needs to read, and every demo visitor shares the
 * same `demo` account, so a server-side per-user flag would show the tour to nobody after the
 * first visitor or everybody forever, neither of which is right.
 */

const STORAGE_KEY = 'opentask_demo_tour_seen'
const START_DELAY_MS = 900
const ELEMENT_POLL_MS = 150
const ELEMENT_WAIT_MS = 4000

export interface DemoTourStep {
  selector: string
  title: string
  body: string
}

// Selectors correspond to `data-tour` attributes added to QuickAdd.tsx and TaskRow.tsx.
// If a step's target never appears (e.g. a demo task with insights isn't visible on screen
// yet), that step is skipped rather than blocking the tour — see the polling effect below.
export const DEMO_TOUR_STEPS: DemoTourStep[] = [
  {
    selector: '[data-tour="quick-add"]',
    title: "Type it like you'd say it",
    body: 'Add a task in plain English — recurrence, due dates, and priority are figured out automatically. Try "walk the dog every day except Saturday at 9am".',
  },
  {
    selector: '[data-tour="task-score"]',
    title: 'AI ranks what matters',
    body: 'Every task gets a 0–100 urgency score from the AI, based on due date, priority, and how long it has been waiting.',
  },
  {
    selector: '[data-tour="task-insight"]',
    title: 'Context, not just a checklist',
    body: 'AI adds a short read on why a task matters right now — no manual tagging required.',
  },
]

function shouldOfferTour(isDemo: boolean): boolean {
  if (!isDemo) return false
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== '1') return false
  if (typeof window === 'undefined') return false
  return !window.localStorage.getItem(STORAGE_KEY)
}

export function useDemoTour() {
  const { data: session, status } = useSession()
  const [active, setActive] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const startedRef = useRef(false)

  const isDemo = status === 'authenticated' && !!session?.user?.is_demo

  const finish = useCallback(() => {
    setActive(false)
    setRect(null)
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, '1')
  }, [])

  // Decide once per session whether to offer the tour at all.
  useEffect(() => {
    if (startedRef.current || !shouldOfferTour(isDemo)) return
    startedRef.current = true
    // Small delay lets the dashboard finish its first paint before the overlay appears.
    const timer = setTimeout(() => setActive(true), START_DELAY_MS)
    return () => clearTimeout(timer)
  }, [isDemo])

  // Track the current step's target element: locate it, scroll it into view, keep the
  // spotlight rect in sync with scroll/resize, and skip the step if the target never shows up.
  useEffect(() => {
    if (!active) return
    const step = DEMO_TOUR_STEPS[stepIndex]
    if (!step) return // out of range shouldn't happen — next()/the timeout branch below call finish() first

    let elapsed = 0
    const locate = () => {
      const el = document.querySelector<HTMLElement>(step.selector)
      if (!el) return false
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setRect(el.getBoundingClientRect())
      return true
    }

    // Always resolve the target from the poll's first tick rather than calling `locate()`
    // synchronously here — keeps every state update in this effect behind a timer/event
    // callback instead of the effect's own synchronous body.
    const poll = setInterval(() => {
      if (locate()) {
        clearInterval(poll)
        return
      }
      elapsed += ELEMENT_POLL_MS
      if (elapsed >= ELEMENT_WAIT_MS) {
        clearInterval(poll)
        if (stepIndex + 1 >= DEMO_TOUR_STEPS.length) finish()
        else setStepIndex((i) => i + 1)
      }
    }, ELEMENT_POLL_MS)

    const reposition = () => locate()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      clearInterval(poll)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [active, stepIndex, finish])

  const next = useCallback(() => {
    setStepIndex((i) => {
      if (i + 1 >= DEMO_TOUR_STEPS.length) {
        finish()
        return i
      }
      return i + 1
    })
  }, [finish])

  return {
    active,
    step: active ? (DEMO_TOUR_STEPS[stepIndex] ?? null) : null,
    stepIndex,
    stepCount: DEMO_TOUR_STEPS.length,
    rect,
    next,
    skip: finish,
  }
}
