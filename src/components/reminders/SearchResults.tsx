'use client'

import { slotGroupKey } from '@/lib/reminder-slots'
import type { ReminderGroup } from '@/hooks/useReminders'
import type { ReminderRowHandlers } from '@/components/reminders/ReminderRow'
import { ReminderSlotGroup } from '@/components/reminders/ReminderSlotGroup'
import { NO_OP, NotTodayFold } from '@/components/reminders/NotTodayFold'
import type { Task } from '@/types'

/**
 * The surface while a search is active.
 *
 * Results are results: the headline and the day bar describe today as a whole,
 * not the matches, so they step aside for a count line — the same move the
 * Tasks page makes with its Track panel. Every slot holding a match renders
 * open and whole, with no "Show all" fold and no caret to collapse it, because
 * a folded result is a result the user cannot see. Clearing the search restores
 * the surface exactly as they left it, since none of this touched the
 * disclosure state.
 */
export function SearchResults({
  count,
  query,
  groups,
  notToday,
  completingIds,
  selectedIds,
  isSelectionMode,
  rowHandlers,
  onPutBack,
  onOpenDetail,
}: {
  count: number
  query: string
  groups: ReminderGroup[]
  notToday: Task[]
  completingIds: Set<number | string>
  selectedIds: Set<number | string>
  isSelectionMode: boolean
  rowHandlers: ReminderRowHandlers
  onPutBack: (task: Task) => void
  onOpenDetail: (task: Task) => void
}) {
  return (
    <>
      <div className="text-muted-foreground mb-4 px-2 text-sm" data-search-count={count}>
        {count} result{count !== 1 ? 's' : ''} for &ldquo;{query}&rdquo;
      </div>
      {count === 0 ? (
        <p className="text-muted-foreground py-12 text-center text-sm">
          No thought here says that.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <ReminderSlotGroup
              key={slotGroupKey(group)}
              group={group}
              started
              open
              expanded
              locked
              onToggle={NO_OP}
              onExpand={NO_OP}
              completingIds={completingIds}
              selectedIds={selectedIds}
              isSelectionMode={isSelectionMode}
              highlightId={null}
              rowHandlers={rowHandlers}
              onCompleteGroup={NO_OP}
              onPutBack={onPutBack}
              onOpenDetail={onOpenDetail}
            />
          ))}
          {notToday.length > 0 && (
            <NotTodayFold items={notToday} onOpen={rowHandlers.onOpen} forceOpen />
          )}
        </div>
      )}
    </>
  )
}
