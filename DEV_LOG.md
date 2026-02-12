# Development Log

Reverse chronological notes on the _why_ behind changes. For implementation details, see git history.

---

## 02-04-26

### Activity/Undo/Toast Consistency Overhaul

**Problem:** Dashboard popover was firing immediate API calls when changing priority/recurrence, creating multiple undo entries and toasts for what felt like one user action. Activity items in history were truncated with no way to see full details.

**Solution:**

1. **Batched saves on dashboard** - QuickActionPanel now uses `onSaveAll` mode (same pattern as task detail page). All changes are staged locally and sent in a single PATCH call when Save is clicked. This means:
   - One API call instead of multiple
   - One undo entry instead of multiple
   - One descriptive toast (e.g., "Updated priority and recurrence")

2. **Enhanced `bulkEdit()` for snooze** - Discovered that `bulkEdit()` didn't handle `due_at` changes at all. Added snooze detection logic matching `updateTask()` so bulk edits now properly track `snooze_count`, `original_due_at`, and daily stats.

3. **Overdue tasks keep overdue status** - Previously, changing rrule on an overdue task would auto-compute a new due_at, making it magically not-overdue. Now: if task is overdue, changing recurrence only updates the schedule, not the due date. You still have to deal with the overdue task.

4. **Preview new due_at when changing recurrence** - When user changes recurrence in QuickActionPanel for a non-overdue task, the UI now shows a preview of what the new due_at will be (computed client-side using rrule library). Helps users understand the impact before saving.

5. **Expandable activity items** - History page now shows chevron on activity items. Click to expand and see full before/after details for each changed field. Collapsed view still truncates for clean list appearance.

**Files touched:**

- `src/app/page.tsx` - Added `handleSaveAllChanges`, wired batched save to popover
- `src/components/QuickActionPopover.tsx` - Added `onSaveAll` prop
- `src/components/QuickActionPanel.tsx` - Added `previewDueAt` computation and display
- `src/core/tasks/bulk.ts` - Added `due_at` handling with snooze detection, overdue check for rrule
- `src/core/tasks/update.ts` - Added overdue check in `applyAnchorUpdates()`
- `src/app/history/page.tsx` - Added expandable activity items with details panel
- `src/lib/format-toast.ts` - New file for `formatChangesToast()` helper

**Key insight:** The staged changes architecture already existed in QuickActionPanel - it was just a matter of wiring up the dashboard to use `onSaveAll` mode instead of individual callbacks. TaskDetail already worked this way.

---

## 02-11-26

### Bubble AI Input Pipeline Improvements

**Problem:** The Bubble AI received a limited view of each task (9 fields), causing commentary that over-focused on "overdue" status. In OpenTask, due dates serve two different purposes:

- **Priority 3-4 (High/Urgent):** Real deadlines that can't be auto-snoozed. Overdue is significant.
- **Priority 0-2 (Unset/Low/Medium):** Notification triggers for auto-snooze cycles. "Overdue" often just means the notification is active — not interesting.

The AI saw `recurring: yes/no` but not the actual rrule pattern (daily vs monthly matters), didn't see `notes` (AI-generated context from dictation), didn't see `recurrence_mode` (from_completion changes overdue semantics), and used an overengineered scoring system with a hard cap of 50 tasks.

**Solution:**

1. **Extended TaskSummary** with `rrule`, `notes`, and `recurrence_mode` fields
2. **Simplified task selection** from a scoring algorithm (score + sort + limit 50) to a simple 7-day filter (include everything due within 7 days, overdue, or no due date)
3. **Updated task line format** to show `rrule: FREQ=WEEKLY;BYDAY=MO` instead of `recurring: yes/no`, plus conditional `recurrence_mode` and `notes`
4. **Rewrote overdue guidance** in the Bubble system prompt with priority-based deadline semantics
5. **Changed one-off task age anchor** from `created_at` to `original_due_at ?? created_at` (captures deferral time)
6. **Added 3 new quality scenarios** testing overdue/deadline distinction: high-priority real deadline, low-priority deferral pattern, and mixed priorities with from_completion

**Rationale:** The previous approach treated all overdue tasks the same way, but OpenTask's auto-snooze model means most "overdue" tasks are just in their notification cycle. By giving the AI the full picture (rrule pattern, notes, recurrence mode) and explicit guidance on deadline semantics, the Bubble can produce more nuanced and useful commentary.
