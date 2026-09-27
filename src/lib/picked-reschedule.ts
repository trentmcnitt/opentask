/**
 * Whether a quick-panel save carries an explicit, date-PICKER reschedule
 * rather than a snooze (Trent, 2026-09-24).
 *
 * A date picked in the panel's date picker is a reschedule: the save adds
 * `reset_original_due_at: true`, and the server makes the new date the
 * occurrence origin instead of counting a snooze (see `collectBasicFields`).
 * "+1h" and the other presets are snoozes and never set `datePicked`.
 *
 * Single-task only — the picker is not shown in bulk mode — and never in
 * create mode, which has no origin to reset. A cleared date (`null`) is not a
 * reschedule either. Lives outside QuickActionPanel so a node test can reach
 * it without loading the component.
 */
export function isPickedReschedule(
  datePicked: boolean,
  isBulkMode: boolean,
  isCreateMode: boolean,
  dueAt: string | null | undefined,
): boolean {
  return datePicked && !isBulkMode && !isCreateMode && typeof dueAt === 'string'
}
