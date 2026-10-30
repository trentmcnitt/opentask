'use client'

import { useRef, useState, useEffect } from 'react'
import { useDrag } from '@use-gesture/react'
import { cn } from '@/lib/utils'

interface SwipeableRowProps {
  children: React.ReactNode
  onSwipeRight?: () => void // done
  onSwipeLeft?: () => void // snooze (overdue) or edit (future/no due date)
  onDragStart?: () => void // called on first meaningful drag movement
  threshold?: number // fraction of width, default 0.4
  disabled?: boolean // disable swiping (e.g. during selection mode)
  leftAction?: 'snooze' | 'edit' // controls swipe-left label and color (default: 'snooze')
  /**
   * What the row sits on: 'card' (the card rows: rounded, `bg-card`) or
   * 'flat' (the lean rows: square edges on the page's own background). The
   * foreground stays opaque either way, so the swipe's action colour never
   * shows through a row that is not being dragged.
   */
  surface?: 'card' | 'flat'
  /**
   * A background for the (opaque) foreground in place of the surface's own:
   * Scan's age steps (`AGE_STEP_CLASS`), with the bucket as `data-age-step`.
   */
  toneClass?: string
  ageStep?: string
}

/**
 * Each surface's container and (always opaque) foreground.
 *
 * FLAT is 4px wider than the row on each side (`-mx-1` out, `px-1` back in):
 * the lean row's state tint is full-bleed, 4px past the row (`LeanRow`'s
 * `TINT_BASE`), and the container clips while a swipe is under way. Sized to
 * the row, it cut the tint's bleed off mid-swipe, so the row's colour
 * narrowed by 4px on each side against its neighbours and the action colour
 * stopped 4px short of theirs (Trent, 2026-10-29: "some visual glitches").
 * Now the container, the action colour and the tint are one width.
 */
const SURFACE = {
  card: { outer: 'rounded-lg', foreground: 'bg-card rounded-lg' },
  flat: { outer: '-mx-1', foreground: 'bg-background px-1' },
} as const

/** Below this much revealed, the action's word would be cut by the row: it fades in after. */
const LABEL_ROOM_PX = 56
/** The word's box: wider than "Defer" / "Done" / "Edit" at text-sm. */
const LABEL_BOX_PX = 56

export function SwipeableRow({
  children,
  onSwipeRight,
  onSwipeLeft,
  onDragStart,
  threshold = 0.4,
  disabled = false,
  leftAction = 'snooze',
  surface = 'card',
  toneClass,
  ageStep,
}: SwipeableRowProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const [swiped, setSwiped] = useState(false)
  const disabledRef = useRef(disabled)
  const swipeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragStarted = useRef(false)
  const [prevDisabled, setPrevDisabled] = useState(disabled)

  // Reset any in-progress swipe when entering selection mode (render-time state adjustment)
  if (disabled !== prevDisabled) {
    setPrevDisabled(disabled)
    if (disabled) {
      setOffset(0)
    }
  }

  // Keep ref in sync and clean up swipe timer on unmount
  useEffect(() => {
    disabledRef.current = disabled
  }, [disabled])

  useEffect(() => {
    return () => {
      if (swipeTimer.current) clearTimeout(swipeTimer.current)
    }
  }, [])

  const bind = useDrag(
    ({ movement: [mx], down, cancel }) => {
      if (swiped || disabledRef.current) {
        if (disabledRef.current) cancel?.()
        return
      }

      const width = containerRef.current?.offsetWidth || 300
      const thresholdPx = width * threshold

      if (down) {
        // Notify parent on first meaningful drag movement (cancels long-press)
        if (!dragStarted.current && Math.abs(mx) > 5) {
          dragStarted.current = true
          onDragStart?.()
        }
        // Clamp movement to reasonable bounds, in WHOLE pixels: a fractional
        // offset re-rasters the row at a subpixel position every frame —
        // the vertical stripes and banding Trent saw mid-swipe (2026-10-30).
        const clamped = Math.round(Math.max(-width * 0.5, Math.min(width * 0.5, mx)))
        setOffset(clamped)
      } else {
        dragStarted.current = false
        // Released
        if (mx > thresholdPx && onSwipeRight) {
          setSwiped(true)
          setOffset(width)
          swipeTimer.current = setTimeout(() => {
            onSwipeRight()
            setOffset(0)
            setSwiped(false)
          }, 200)
        } else if (mx < -thresholdPx && onSwipeLeft) {
          setSwiped(true)
          setOffset(-width)
          swipeTimer.current = setTimeout(() => {
            onSwipeLeft()
            setOffset(0)
            setSwiped(false)
          }, 200)
        } else {
          setOffset(0)
        }
        cancel?.()
      }
    },
    {
      axis: 'x',
      filterTaps: true,
      pointer: { capture: false }, // Disable pointer capture to fix focus-related click issues
    },
  )

  return (
    <div
      ref={containerRef}
      // `data-swiping` while the row is off its place: the container clips
      // then, and a row hides its focus and selection outline
      // (`group-data-swiping/swipe:`), which would ride along on the moving
      // layer.
      data-swiping={offset !== 0 ? '' : undefined}
      className={cn(
        'group/swipe relative',
        SURFACE[surface].outer,
        'overflow-visible data-swiping:overflow-hidden',
      )}
    >
      {offset !== 0 && <SwipeReveal offset={offset} leftAction={leftAction} />}

      {/* Foreground content — bg-card ensures an opaque base so swipe
         action labels never bleed through semi-transparent child backgrounds */}
      <div
        {...(disabled ? {} : bind())}
        className={cn(SURFACE[surface].foreground, toneClass)}
        data-age-step={ageStep}
        style={{
          // Its own compositor layer while it moves (`translate3d`,
          // `will-change`): the slide is then a move of a layer painted once,
          // not a repaint of the row every frame (the lag, 2026-10-30).
          transform: offset === 0 ? 'translateX(0)' : `translate3d(${offset}px, 0, 0)`,
          willChange: offset === 0 ? undefined : 'transform',
          transition: offset === 0 || swiped ? 'transform 0.2s ease-out' : 'none',
          touchAction: disabled ? undefined : 'pan-y',
        }}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * The background a swipe reveals: green Done to the right, blue Defer (amber
 * Edit) to the left. The word is centred in the strip the row has uncovered
 * and shows only once it fits — pinned to the far edge, the row slid over it
 * ("Def" cut off, Trent, 2026-10-30). Nothing here changes size as the row
 * moves: the panel is the whole row, and the word's fixed-width box follows
 * the strip's centre by a compositor transform, so a frame of the swipe
 * paints nothing (the lag and the stripes).
 */
function SwipeReveal({ offset, leftAction }: { offset: number; leftAction: 'snooze' | 'edit' }) {
  const right = offset > 0
  const edit = leftAction === 'edit'
  // The box's centre at the uncovered strip's centre: |offset| / 2 in from the edge.
  const shift = Math.abs(offset) / 2 - LABEL_BOX_PX / 2
  return (
    <div
      className={cn(
        'absolute inset-0 rounded-[inherit]',
        right ? 'bg-green-500' : edit ? 'bg-amber-500' : 'bg-blue-500',
      )}
    >
      <div
        data-swipe-label
        className={cn(
          'absolute inset-y-0 flex items-center justify-center transition-opacity duration-100',
          right ? 'left-0' : 'right-0',
          Math.abs(offset) < LABEL_ROOM_PX && 'opacity-0',
        )}
        style={{
          width: LABEL_BOX_PX,
          transform: `translate3d(${right ? shift : -shift}px, 0, 0)`,
          willChange: 'transform',
        }}
      >
        <span className="text-sm font-medium whitespace-nowrap text-white">
          {right ? 'Done' : edit ? 'Edit' : 'Defer'}
        </span>
      </div>
    </div>
  )
}
