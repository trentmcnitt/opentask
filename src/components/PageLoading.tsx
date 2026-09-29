import { cn } from '@/lib/utils'

/**
 * The full-page "Loading..." placeholder a page shows while its session (and
 * whatever else it waits for) resolves. It fills the page's flex column by
 * default; pass `className` to size it differently (the task detail page
 * fills the screen).
 */
export function PageLoading({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-1 items-center justify-center', className)}>
      <div className="text-muted-foreground animate-pulse">Loading...</div>
    </div>
  )
}
