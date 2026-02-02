'use client'

import { useRef, useState, useEffect } from 'react'
import { useDrag } from '@use-gesture/react'

interface SwipeableRowProps {
  children: React.ReactNode
  onSwipeRight?: () => void // done
  onSwipeLeft?: () => void // snooze +1h
  onDragStart?: () => void // called on first meaningful drag movement
  threshold?: number // fraction of width, default 0.4
  disabled?: boolean // disable swiping (e.g. during selection mode)
}

export function SwipeableRow({
  children,
  onSwipeRight,
  onSwipeLeft,
  onDragStart,
  threshold = 0.4,
  disabled = false,
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
        // Clamp movement to reasonable bounds
        const clamped = Math.max(-width * 0.5, Math.min(width * 0.5, mx))
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
    },
  )

  const bgColor = offset > 0 ? 'bg-green-500' : offset < 0 ? 'bg-blue-500' : ''

  const label = offset > 0 ? 'Done' : offset < 0 ? 'Snooze' : ''

  return (
    <div ref={containerRef} className="relative overflow-hidden rounded-lg">
      {/* Background revealed by swipe */}
      {offset !== 0 && (
        <div
          className={`absolute inset-0 ${bgColor} flex items-center ${
            offset > 0 ? 'justify-start pl-4' : 'justify-end pr-4'
          }`}
        >
          <span className="text-sm font-medium text-white">{label}</span>
        </div>
      )}

      {/* Foreground content */}
      <div
        {...bind()}
        style={{
          transform: `translateX(${offset}px)`,
          transition: offset === 0 || swiped ? 'transform 0.2s ease-out' : 'none',
          touchAction: 'pan-y',
        }}
      >
        {children}
      </div>
    </div>
  )
}
