/**
 * The app's primary "Add" control, shared by the desktop left bar's button and
 * the top bar's ☰ menu item (2026-10-14). Both run `AppLayout`'s
 * `handleAddClick`, which adds the thing the surface is about: a reminder on
 * Reminders, a quota on Quotas, otherwise the full task form (navigating to
 * the dashboard first). The left bar calls it directly; the ☰ menu, which
 * lives in `Header` outside `AppLayout`'s reach, dispatches `OPEN_ADD_EVENT`.
 */
export const OPEN_ADD_EVENT = 'open-add'

/** The control's words on the current surface. */
export function addActionLabel(pathname: string): string {
  if (pathname.startsWith('/reminders')) return 'Add Reminder'
  if (pathname.startsWith('/quotas')) return 'Add Quota'
  return 'Add Task'
}
