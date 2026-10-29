'use client'

import type { CSSProperties } from 'react'
import { CREATED_BUCKETS, type CreatedBucket } from '@/lib/created-bucket'

/**
 * A DATE BREAK between two of Scan's rows (Trent, 2026-10-29, "F3 at 30%":
 * mockup `scan-r6-fade`): where the created-date bucket changes, the rows'
 * hairline becomes a 2px line in the INCOMING bucket's colour, broken around
 * its name in small capitals, centred. No extra row: it is zero-height,
 * drawn on the boundary (`-top-[7px]`, the line straddling it), and the list
 * hides the hairline it replaces (`DATE_BREAK_CONTAINER`).
 *
 * Line and label are the bucket colour mixed 30% toward the page background
 * (`color-mix`, not opacity — nothing shows through the label), in either
 * theme: `--background` is the page's own, light or dark. The line is two
 * segments around the label, so no background box sits over a tinted row.
 */
const MIX = 'color-mix(in srgb, var(--bc) 30%, var(--background))'

export function DateBreak({ bucket }: { bucket: CreatedBucket }) {
  const { label, color } = CREATED_BUCKETS[bucket]
  return (
    <div
      data-date-break={bucket}
      role="separator"
      aria-label={label}
      className="relative z-[3] h-0"
      style={{ '--bc': color } as CSSProperties}
    >
      <div className="absolute inset-x-0 -top-[7px] flex h-[14px] items-center gap-1.5">
        <span className="h-0.5 flex-1" style={{ background: MIX }} />
        <span
          className="text-[10.5px] leading-[14px] font-semibold tracking-[0.06em] uppercase"
          style={{ color: MIX }}
        >
          {label}
        </span>
        <span className="h-0.5 flex-1" style={{ background: MIX }} />
      </div>
    </div>
  )
}

/**
 * The rows' box when it draws breaks: the row just above a break gives up
 * its hairline (the break's line takes its place, and none shows in the
 * label's gap).
 */
export const DATE_BREAK_CONTAINER =
  '[&>*:has(+[data-date-break])_[data-lean-row]]:border-b-transparent'
