'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ProcessShell } from './ProcessShell'
import { ProcessInboxStep } from './ProcessInboxStep'
import { ProcessDuplicatesStep } from './ProcessDuplicatesStep'
import { ProcessGrowthStep } from './ProcessGrowthStep'
import { HORIZON_WORD } from '@/lib/task-model-words'
import { ProcessTargetsStep } from './ProcessTargetsStep'
import { useProcessBatchActions, useProcessFlow } from './useProcessFlow'

type StepId = 'inbox' | 'duplicates' | 'growth' | 'targets'

const STEP_LABEL: Record<StepId, string> = {
  inbox: 'Inbox',
  duplicates: 'Duplicates',
  growth: `${HORIZON_WORD}s`,
  targets: 'Old targets',
}
const STEP_ORDER: StepId[] = ['inbox', 'duplicates', 'growth', 'targets']

/**
 * Process (2026-10-10 task model, spec §5): one button that works the Inbox
 * and the backlog, as steps in one modal — sort the Inbox, possible
 * duplicates, horizon growth, old targets. Trent (10-10): "press Sort, a modal
 * pops up … For what it can't sort, it shows me the task and I pick the
 * project". Opened from the top bar's menu (`ProcessMenuItem`).
 *
 * The chrome is `ProcessShell` — `DetailModalShell`'s dialog/sheet, minus the
 * unsaved-changes guard (every tap writes at once, with Undo on its toast)
 * and with taps on a toast kept from closing it.
 *
 * STEPS. A step with nothing in it is not shown ("no chrome for something
 * that isn't there"); the step you are on stays, saying it is done, with Next
 * to the next one that has work. The pills jump between steps. Duplicates is
 * AI-found and arrives a moment later, or never with AI off.
 */
export function ProcessModal({
  open,
  onOpenChange,
  timezone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  timezone: string
}) {
  const flow = useProcessFlow(open)
  const actions = useProcessBatchActions(flow)
  const [chosen, setChosen] = useState<StepId | null>(null)
  const { data } = flow

  const counts: Record<StepId, number> = {
    inbox: flow.inboxQueue.length,
    duplicates: flow.duplicates.length,
    growth: data?.growth.length ?? 0,
    targets: (data?.stale_targets.length ?? 0) + (data?.stale_targets_with_deadline.length ?? 0),
  }
  // The step is pinned once there is something to show, so a step that
  // fills in late (the AI's duplicates) never pulls the user off the one they
  // are on, and a finished step stays, saying so, until they move on. Set
  // during render: React's pattern for state derived from a previous render.
  const firstWithWork = STEP_ORDER.find((s) => counts[s] > 0) ?? null
  if (chosen === null && firstWithWork !== null) setChosen(firstWithWork)
  const step: StepId | null = chosen ?? firstWithWork
  const visible = STEP_ORDER.filter((s) => counts[s] > 0 || s === step)
  const next = step
    ? STEP_ORDER.slice(STEP_ORDER.indexOf(step) + 1).find((s) => counts[s] > 0)
    : undefined

  const close = () => onOpenChange(false)

  return (
    <ProcessShell open={open} onClose={close}>
      <div className="flex flex-col gap-4 pt-1" data-process-modal>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Process</h2>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            Done
          </Button>
        </div>

        {visible.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Process steps">
            {visible.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={s === step}
                onClick={() => setChosen(s)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs',
                  s === step
                    ? 'bg-foreground text-background'
                    : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {STEP_LABEL[s]}
                {counts[s] > 0 && <span className="ml-1 tabular-nums">{counts[s]}</span>}
              </button>
            ))}
          </div>
        )}

        <ProcessBody flow={flow} actions={actions} step={step} timezone={timezone} />

        {step && counts[step] === 0 && next && (
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={() => setChosen(next)}>
              Next: {STEP_LABEL[next]}
            </Button>
          </div>
        )}
      </div>
    </ProcessShell>
  )
}

function ProcessBody({
  flow,
  actions,
  step,
  timezone,
}: {
  flow: ReturnType<typeof useProcessFlow>
  actions: ReturnType<typeof useProcessBatchActions>
  step: StepId | null
  timezone: string
}) {
  const { data } = flow
  if (!data) {
    return flow.error ? (
      <p className="text-muted-foreground py-8 text-center text-sm">Couldn&rsquo;t load Process.</p>
    ) : (
      <div className="text-muted-foreground animate-pulse py-8 text-center text-sm">Loading…</div>
    )
  }
  if (!step) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm" data-process-empty>
        Nothing to process right now.
      </p>
    )
  }
  switch (step) {
    case 'inbox': {
      const task = flow.inboxQueue[0] ?? null
      return (
        <ProcessInboxStep
          task={task}
          remaining={flow.inboxQueue.length}
          projects={flow.inboxProjects}
          recommendation={task ? flow.recommendations.get(task.id) : undefined}
          onMove={flow.move}
          onSkip={flow.skip}
        />
      )
    }
    case 'duplicates':
      return (
        <ProcessDuplicatesStep
          groups={flow.duplicates}
          projects={flow.projects}
          onTrash={flow.trash}
          onDismiss={flow.dismiss}
        />
      )
    case 'growth':
      return (
        <ProcessGrowthStep
          items={data.growth}
          busy={flow.busy}
          onApply={actions.applyGrowth}
          onDoIt={actions.doIt}
          onRaise={actions.raise}
        />
      )
    case 'targets':
      return (
        <ProcessTargetsStep
          plain={data.stale_targets}
          withDeadline={data.stale_targets_with_deadline}
          timezone={timezone}
          busy={flow.busy}
          onRemove={actions.removeTargets}
        />
      )
  }
}
