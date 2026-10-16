'use client'

import { useLayoutEffect, useRef, useState, type HTMLAttributes, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import {
  chooseQuotaCountForm,
  quotaCountAriaLabel,
  quotaCountText,
  quotaSegmentWord,
  segmentFills,
  type QuotaCountForm,
  type SegmentFill,
} from '@/lib/quota-segments'

/**
 * A quota's count, drawn as SEGMENTS (2026-10-13, Trent: "I like it" — mockup
 * r4, size S4): N small skewed boxes, one per unit of the target, indigo per
 * completion logged, all green (with the period word) once met — then the
 * period word, "▰▱ today". Used by every web surface that shows a quota's
 * count: the reminder prompt rows (`QuotaPromptRow`, both sizes, and the
 * considered rows), the Quotas page row and the Track panel's chips.
 *
 * TEXT FALLBACK. The segments give way to plain "3/7 today" — the old count's
 * look, no marker — when the target is above six, or when the segments and
 * their word do not fit on the line where they start but the text does. When
 * neither fits, the segments wrap to the next line as one piece (the unit is
 * `nowrap`). The rule itself is `chooseQuotaCountForm` in
 * `src/lib/quota-segments.ts`; this component only measures.
 *
 * HOW IT MEASURES (deterministic: no timers, no tolerances).
 * - `inline` (the default) is for a count that follows a title in running
 *   text. The component renders a zero-width ANCHOR right after the title,
 *   BEFORE the breaking space, then the space, then the count. The anchor's
 *   position is the end of the title's last line, and it does not move
 *   whichever form the count takes — the space before it is the only break
 *   point, and nothing before it reflows (hosts must not use `text-pretty`,
 *   which rebalances lines by what follows). So `available` = the line's right
 *   edge − the anchor, and a choice can never invalidate itself.
 * - The width each form needs is read from an invisible twin of each, the
 *   space before it included. The twins sit out of flow at the top-left of
 *   the host's positioned row (a few em wide, so inside it). Not clipped into
 *   a 0×0 box: a clipped span is what the chips' "nothing clipped" check
 *   looks for.
 * - Measured before paint (`useLayoutEffect`), on every render (a new title
 *   moves the anchor), and again from a `ResizeObserver` on the line box and
 *   on both twins — the twins change size when a web font swaps in.
 * - An element that is not laid out (`display: none` — the dashboard panel's
 *   narrow-hidden rows) keeps its form until it is.
 * - With `inline={false}` the host lays the count out in a column of its own,
 *   so only the "more than six" rule applies.
 *
 * ACCESSIBILITY. The group is `role="img"` named "1 of 2 today" / "1 of 2 this
 * week" (`quotaCountAriaLabel`); the boxes and the visible text are
 * `aria-hidden`, so both forms read the same.
 *
 * TEST HOOKS. `data-quota-segments`, `data-count="3/7"` and
 * `data-count-form="segments" | "text"` sit on the group, beside any `data-*`
 * the host passes through; each box inside it carries `data-seg="empty" |
 * "filled" | "met"`. (The measuring twins sit outside the group.)
 */
export interface QuotaSegmentsProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  current: number
  target: number
  /** The quota's FREQ ('DAILY', 'WEEKLY', …); null for a period-less quota. */
  freq: string | null | undefined
  /** Show the period word after the count. Off on a Track chip, whose section names it. */
  showWord?: boolean
  /**
   * Interval quotas (2026-10-16): the server's served label ("by Oct 24",
   * `period_label`) — used as the word in place of the FREQ's ("week"), and in
   * the accessible name. Null/omitted at interval 1.
   */
  periodLabel?: string | null
  /** Follows a title in running text (see HOW IT MEASURES). */
  inline?: boolean
  /** The text form's numerator in the foreground, medium weight (the chips' and Quotas page's look). */
  emphasizeCurrent?: boolean
  /** Size of the word and the text form, relative to the host's font. */
  textClassName?: string
  /**
   * Where the line ends, for a host whose anchor parent is not the line box —
   * a chip's title span shrinks to fit its content, so its own right edge is
   * no limit. Returns the right edge (viewport px) and the element whose
   * resize can move it.
   */
  lineEnd?: (anchorParent: HTMLElement) => { right: number; resizeTarget: Element }
}

const SEG_FILL_CLASS: Record<SegmentFill, string> = {
  empty:
    'border-foreground/45 bg-foreground/5 opacity-80 dark:border-foreground/55 dark:bg-foreground/10',
  filled: 'border-indigo-600 bg-indigo-600 dark:border-indigo-500 dark:bg-indigo-500',
  met: 'border-green-600 bg-green-600',
}

const MET_TEXT = 'text-green-700 dark:text-green-400'

/** The default line end: the anchor parent's content box. */
function contentBoxEnd(parent: HTMLElement): { right: number; resizeTarget: Element } {
  const style = getComputedStyle(parent)
  const right =
    parent.getBoundingClientRect().right -
    parseFloat(style.paddingRight) -
    parseFloat(style.borderRightWidth)
  return { right, resizeTarget: parent }
}

/**
 * Keeps the count's form in step with its line. See HOW IT MEASURES above.
 */
function useCountForm({
  target,
  inline,
  anchorRef,
  segGhostRef,
  textGhostRef,
  lineEnd,
}: {
  target: number
  inline: boolean
  anchorRef: RefObject<HTMLSpanElement | null>
  segGhostRef: RefObject<HTMLSpanElement | null>
  textGhostRef: RefObject<HTMLSpanElement | null>
  lineEnd?: QuotaSegmentsProps['lineEnd']
}): QuotaCountForm {
  // First render (and the server's): from the props alone.
  const [form, setForm] = useState<QuotaCountForm>(() => chooseQuotaCountForm({ target }))
  // The latest measure, for the observer below without re-subscribing it.
  const measureRef = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    measureRef.current = () => {
      const anchor = anchorRef.current
      const parent = anchor?.parentElement
      const segGhost = segGhostRef.current
      const textGhost = textGhostRef.current
      if (!inline || !anchor || !parent || !segGhost || !textGhost) {
        const next = chooseQuotaCountForm({ target })
        setForm((prev) => (prev === next ? prev : next))
        return
      }
      // Not laid out (display: none): nothing to measure against.
      if (parent.getClientRects().length === 0) return
      const end = (lineEnd ?? contentBoxEnd)(parent)
      const next = chooseQuotaCountForm({
        target,
        available: end.right - anchor.getBoundingClientRect().right,
        segmentsWidth: segGhost.getBoundingClientRect().width,
        textWidth: textGhost.getBoundingClientRect().width,
      })
      setForm((prev) => (prev === next ? prev : next))
    }
    measureRef.current()
  })

  useLayoutEffect(() => {
    const parent = anchorRef.current?.parentElement
    if (!inline || !parent || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measureRef.current())
    ro.observe(parent)
    const lineTarget = (lineEnd ?? contentBoxEnd)(parent).resizeTarget
    if (lineTarget !== parent) ro.observe(lineTarget)
    if (segGhostRef.current) ro.observe(segGhostRef.current)
    if (textGhostRef.current) ro.observe(textGhostRef.current)
    return () => ro.disconnect()
  }, [inline, lineEnd, anchorRef, segGhostRef, textGhostRef])

  return form
}

/** The boxes, then the word. Sized in the host's em; the word in `textClassName`. */
function SegmentsForm({
  fills,
  word,
  met,
  textClassName,
}: {
  fills: SegmentFill[]
  word: string | null
  met: boolean
  textClassName: string
}) {
  return (
    <>
      <span
        className={cn('ml-[0.05em] inline-flex gap-[0.11em] align-baseline', word && 'mr-[0.32em]')}
      >
        {fills.map((fill, i) => (
          <span
            key={i}
            data-seg={fill}
            className={cn(
              'inline-block h-[0.45em] w-[0.65em] skew-x-[-16deg] rounded-[1.5px] border',
              SEG_FILL_CLASS[fill],
            )}
          />
        ))}
      </span>
      {word && (
        <span className={cn(textClassName, met ? MET_TEXT : 'text-muted-foreground')}>{word}</span>
      )}
    </>
  )
}

/** "3/7 today" — the count as it read before the segments. */
function TextForm({
  current,
  target,
  word,
  met,
  emphasizeCurrent,
  textClassName,
}: {
  current: number
  target: number
  word: string | null
  met: boolean
  emphasizeCurrent: boolean
  textClassName: string
}) {
  return (
    <span className={cn(textClassName, met ? MET_TEXT : 'text-muted-foreground')}>
      {emphasizeCurrent ? (
        <>
          <span className={cn('font-medium', met ? MET_TEXT : 'text-foreground')}>{current}</span>/
          {target}
          {word ? ` ${word}` : ''}
        </>
      ) : (
        quotaCountText(current, target, word)
      )}
    </span>
  )
}

export function QuotaSegments({
  current,
  target: rawTarget,
  freq,
  showWord = true,
  periodLabel = null,
  inline = true,
  emphasizeCurrent = false,
  textClassName = 'text-[0.85em]',
  lineEnd,
  className,
  ...rest
}: QuotaSegmentsProps) {
  const target = Math.max(1, rawTarget)
  const met = current >= target
  const word = showWord ? quotaSegmentWord(freq, periodLabel) : null
  const fills = segmentFills(current, target)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const segGhostRef = useRef<HTMLSpanElement>(null)
  const textGhostRef = useRef<HTMLSpanElement>(null)
  const form = useCountForm({ target, inline, anchorRef, segGhostRef, textGhostRef, lineEnd })

  const segments = (
    <SegmentsForm fills={fills} word={word} met={met} textClassName={textClassName} />
  )
  const text = (
    <TextForm
      current={current}
      target={target}
      word={word}
      met={met}
      emphasizeCurrent={emphasizeCurrent}
      textClassName={textClassName}
    />
  )
  // The unit's own box: the gap before it and `nowrap`, so it moves as one.
  const unitClass = cn('whitespace-nowrap tabular-nums', inline && 'ml-[1px]')

  const group = (
    <span
      {...rest}
      role="img"
      aria-label={quotaCountAriaLabel(current, target, freq, periodLabel)}
      data-quota-segments=""
      data-count={`${current}/${target}`}
      data-count-form={form}
      className={cn(unitClass, className)}
    >
      <span aria-hidden="true">{form === 'segments' ? segments : text}</span>
    </span>
  )

  if (!inline) return group

  return (
    <>
      {/* The anchor: the end of the title, before the break point. */}
      <span ref={anchorRef} aria-hidden="true" /> {group}
      {/* The twins each form is measured by — the space before it included
          (a no-break space is a space's width). Out of flow, invisible. */}
      <span
        aria-hidden="true"
        className="pointer-events-none invisible absolute top-0 left-0 w-max"
      >
        <span ref={segGhostRef} className="block w-max whitespace-nowrap tabular-nums">
          {' '}
          <span className="ml-[1px]">{segments}</span>
        </span>
        <span ref={textGhostRef} className="block w-max whitespace-nowrap tabular-nums">
          {' '}
          <span className="ml-[1px]">{text}</span>
        </span>
      </span>
    </>
  )
}
