'use client'

export interface NowSummaryState {
  /** Rows relevant now, across every project (`isRelevantNow`). */
  relevant: number
  /** Every row in the list. */
  total: number
  /** Show all is on: Now's folds are lifted. */
  showAll: boolean
  onShowAllChange: (showAll: boolean) => void
}

/**
 * Now's strip beside the view switch (mockup E1, 2026-10-14): "14 of 42 now ·
 * Show all 42". Show all lifts every project's fold for the visit — the old
 * All — and the strip then offers the way back: "All 42 · Show 14 now". Not
 * shown outside Now, while a search or filter narrows the list (the folds
 * are off then), or when nothing is folded (every row relevant, or an empty
 * list): there is nothing to lift. The rule: `src/lib/now-view.ts`.
 */
export function NowSummary({ relevant, total, showAll, onShowAllChange }: NowSummaryState) {
  return (
    <div data-now-summary className="flex min-w-0 items-center gap-2 text-xs">
      <span className="text-muted-foreground truncate whitespace-nowrap">
        {showAll ? `All ${total}` : `${relevant} of ${total} now`}
      </span>
      <button
        type="button"
        onClick={() => onShowAllChange(!showAll)}
        className="border-border bg-background text-foreground hover:bg-muted shrink-0 rounded-md border px-2 py-1 font-medium whitespace-nowrap transition-colors"
      >
        {showAll ? `Show ${relevant} now` : `Show all ${total}`}
      </button>
    </div>
  )
}
