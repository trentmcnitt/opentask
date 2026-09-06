'use client'

import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { useIsMobile } from '@/hooks/useIsMobile'
import { trackState, periodLabel } from '@/lib/track'
import { formatRRule } from '@/lib/format-rrule'
import type { Task } from '@/types'

/**
 * What a quota is, behind its chip — a readout, not an editor.
 *
 * Trent, 2026-09-06: "When I press and hold I don't want to add notes to it.
 * It should just show me the notes. I don't want an editable field… I just
 * wanted a popover or something that gave me some valuable information."
 *
 * The same message asked "What is Track? Is it a different type of task? How
 * do I even edit the Track items?" — which is a fair question the UI could not
 * answer, because a quota IS an ordinary task (a `progress_target` above 1 is
 * the whole difference) and yet the chips were the one row in the app with no
 * route to their own task. So this panel ends in "Open task", and editing —
 * notes included — happens in the ordinary task editor like everything else.
 *
 * A sheet on the phone, a dialog on the desktop, matching ReminderDetail.
 */
export function TrackDetailSheet({
  task,
  open,
  onOpenChange,
}: {
  task: Task | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isMobile = useIsMobile()
  const router = useRouter()

  if (!task) return null

  const state = trackState(task)
  const period = periodLabel(task.rrule)
  const cadence = task.rrule ? formatRRule(task.rrule, task.anchor_time) : null

  const body = (
    <div className="space-y-4 px-4 pb-4">
      <section>
        <h3 className="text-muted-foreground mb-1 text-xs">Notes</h3>
        {task.notes ? (
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{task.notes}</p>
        ) : (
          <p className="text-muted-foreground text-sm italic">
            Nothing written down yet — open the task to say what this one means.
          </p>
        )}
      </section>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 text-sm">
        {cadence && (
          <div className="col-span-2">
            <dt className="text-muted-foreground text-xs">Cadence</dt>
            <dd>{cadence}</dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground text-xs">Logged so far</dt>
          <dd className="tabular-nums">
            <span className="font-medium">{state.current}</span> of {state.target}
            {period && <span className="text-muted-foreground"> {period}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Periods met</dt>
          {/* The honest history: how many times this quota has actually been
              reached. Zero is a real and useful answer — it says the routine
              has never once happened, which is the thing worth knowing. */}
          <dd className="tabular-nums">
            {task.completion_count > 0 ? `${task.completion_count}×` : 'Never yet'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Tracking since</dt>
          <dd>{formatMonth(task.created_at)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Last met</dt>
          <dd>{task.last_completed_at ? formatMonth(task.last_completed_at) : '—'}</dd>
        </div>
      </dl>

      {/* No Close button: the dialog and the sheet both already carry an X,
          and two controls labelled "Close" is one too many. */}
      <div className="flex items-center justify-end border-t pt-3">
        <Button onClick={() => router.push(`/tasks/${task.id}`)}>Open task</Button>
      </div>
    </div>
  )

  const description = `${state.current} of ${state.target}${period ? ` ${period}` : ''}`

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
          <div className="px-4 pt-4 pb-2">
            <SheetTitle className="text-left">{task.title}</SheetTitle>
            <SheetDescription className="text-left">{description}</SheetDescription>
          </div>
          {body}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <div className="px-4 pt-4 pb-2">
          <DialogTitle>{task.title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </div>
        {body}
      </DialogContent>
    </Dialog>
  )
}

/** "March 2026" — the month is the useful grain for a quota's history. */
function formatMonth(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
