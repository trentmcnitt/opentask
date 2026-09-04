'use client'

import { useEffect, useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDemoTour } from '@/hooks/useDemoTour'

const SPOTLIGHT_PADDING = 8
const CALLOUT_WIDTH = 300
const CALLOUT_MARGIN = 16
// Rough estimate used only to decide above-vs-below placement before the callout has
// actually laid out — doesn't need to be exact, just enough to avoid clipping at the
// bottom of the viewport.
const CALLOUT_HEIGHT_ESTIMATE = 190

/** Where to draw the callout card relative to the spotlighted element, clamped on-screen. */
function calloutPosition(rect: DOMRect) {
  const fitsBelow = rect.bottom + CALLOUT_HEIGHT_ESTIMATE + CALLOUT_MARGIN < window.innerHeight
  const top = fitsBelow
    ? rect.bottom + CALLOUT_MARGIN
    : Math.max(CALLOUT_MARGIN, rect.top - CALLOUT_HEIGHT_ESTIMATE - CALLOUT_MARGIN)
  const left = Math.min(
    Math.max(rect.left, CALLOUT_MARGIN),
    window.innerWidth - CALLOUT_WIDTH - CALLOUT_MARGIN,
  )
  return { top, left }
}

// Demo-only, first-visit spotlight tour. See useDemoTour.ts for the gating/persistence logic —
// this component is purely presentational and renders nothing once that hook reports inactive.
export function DemoTour() {
  const { active, step, stepIndex, stepCount, rect, next, skip } = useDemoTour()

  // Escape dismisses the tour like any other overlay in the app.
  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') skip()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, skip])

  const position = useMemo(() => (rect ? calloutPosition(rect) : null), [rect])

  if (!active || !step || !rect || !position) return null

  const isLastStep = stepIndex === stepCount - 1

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-label="Demo tour" aria-live="polite">
      {/* Spotlight ring: a transparent box the size of the target, whose oversized box-shadow
          dims everything else. This single element both darkens the background and blocks
          clicks on it, while leaving the target visually uncovered. */}
      <div
        className="absolute rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.6)] transition-all duration-300"
        style={{
          top: rect.top - SPOTLIGHT_PADDING,
          left: rect.left - SPOTLIGHT_PADDING,
          width: rect.width + SPOTLIGHT_PADDING * 2,
          height: rect.height + SPOTLIGHT_PADDING * 2,
        }}
      />

      <div
        className="bg-card text-card-foreground absolute rounded-lg border p-4 shadow-xl"
        style={{ top: position.top, left: position.left, width: CALLOUT_WIDTH }}
      >
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 size-4 flex-shrink-0 text-indigo-500" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{step.title}</h2>
            <p className="text-muted-foreground mt-1 text-sm">{step.body}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-muted-foreground text-xs">
            {stepIndex + 1} of {stepCount}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={skip}>
              Skip
            </Button>
            <Button size="sm" onClick={next}>
              {isLastStep ? 'Got it' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
