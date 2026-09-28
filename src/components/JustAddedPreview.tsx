'use client'

import { TaskRow } from './TaskRow'
import type { LabelColor, Task } from '@/types'

interface JustAddedPreviewProps {
  task: Task
  /** The task's project, named only when it is not the Inbox ("→ Work"). */
  projectName?: string
  projectColor?: LabelColor | null
  /** "New · 3m" */
  badge: string
  /** Scroll to the real row and flash it (or open the task when it has no row in this view). */
  onShow: () => void
}

const noop = () => {}

/**
 * A just-added task's read-only preview, at the top of the Inbox (or of the
 * list) for its first 10 minutes — see `src/lib/just-added.ts` for why.
 *
 * The row inside is a `TaskRow` in `preview` mode, so it shows exactly what
 * the real row shows (labels, priority, due, recurrence, the enrichment
 * pulse) and follows every future change to it, with none of its behavior.
 * The whole preview is ONE control: a tap (or Enter/Space) goes to the real
 * row. The click is taken in the CAPTURE phase because some of the row's
 * pieces (label badges) stop propagation of their own clicks.
 *
 * Not an `option` of the task listbox — it is outside selection, shift-click
 * ranges, keyboard navigation, Select All and every count.
 */
export function JustAddedPreview({
  task,
  projectName,
  projectColor,
  badge,
  onShow,
}: JustAddedPreviewProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-just-added-preview={task.id}
      aria-label={`New: ${task.title}. Show it in the list.`}
      title="Just added — tap to show it in the list"
      className="cursor-pointer rounded-lg"
      onClickCapture={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onShow()
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          onShow()
        }
      }}
    >
      <TaskRow
        task={task}
        preview
        onDone={noop}
        onSnooze={noop}
        projectName={projectName}
        projectColor={projectColor}
        justAddedBadge={badge}
      />
    </div>
  )
}
