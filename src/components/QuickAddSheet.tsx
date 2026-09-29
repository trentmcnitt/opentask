'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { QuickAdd } from '@/components/QuickAdd'

/** Window event the phone's `+` tab fires on the dashboard (`AppLayout`). */
export const OPEN_QUICK_ADD_EVENT = 'open-quick-add'
/** `/?action=quick-add` — the `+` tab from any other page navigates here. */
export const QUICK_ADD_ACTION = 'quick-add'

/**
 * Open state for `QuickAddSheet`, owned by the dashboard (whose submit the
 * sheet uses). Two ways in, both from the phone's `+` tab via `AppLayout`:
 * - already on the dashboard: the `open-quick-add` window event;
 * - on another page: `AppLayout` navigates to `/?action=quick-add`, and this
 *   seeds the open state from the param on mount (then strips it from the
 *   URL), as the dashboard seeds `?filter=`. An event fired before the
 *   dashboard mounted would be lost; the URL survives the navigation.
 */
export function useQuickAddSheet() {
  const searchParams = useSearchParams()
  const [open, setOpen] = useState(() => searchParams.get('action') === QUICK_ADD_ACTION)

  useEffect(() => {
    if (searchParams.get('action') === QUICK_ADD_ACTION) {
      window.history.replaceState(window.history.state, '', window.location.pathname)
    }
  }, [searchParams])

  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener(OPEN_QUICK_ADD_EVENT, handler)
    return () => window.removeEventListener(OPEN_QUICK_ADD_EVENT, handler)
  }, [])

  return { open, setOpen }
}

interface QuickAddSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The dashboard's own quick-add submit — the same function its QuickAdd field uses. */
  onAdd: (title: string) => Promise<unknown>
  /** Open the full add-task form (`CreateTaskPanel`), carrying what was typed. */
  onOpenAddForm: (title: string) => void
}

/**
 * The phone's `+` tab: a quick-add field at thumb level (Trent, 2026-09-29).
 *
 * The `+` used to open the full add-task form, whose title field sits at the
 * top of a tall sheet. Most adds are one line of natural language that the AI
 * fills in, which is what the dashboard's quick-add field is for — but that
 * field is at the top of the page, out of thumb reach. This sheet is that
 * same field, at the bottom:
 *
 * - **The same submit.** It renders `QuickAdd` and hands it the dashboard's
 *   `onQuickAdd` — the exact function behind the field at the top of the page
 *   — so AI enrichment, the Quick Take banner, the toasts and the Just added
 *   card all behave identically. Nothing about submitting lives here.
 * - **Return submits and closes.** The new task then shows in the Just added
 *   card under the top field. `onSubmitted` closes the sheet instead of
 *   QuickAdd's usual re-focus for a next entry.
 * - **"Add manually"** (QuickAdd's `manualAdd="link"`) closes this and opens
 *   the full form (what `+` opened before), carrying anything typed.
 * - **Closing:** Escape, a downward swipe (the Sheet primitive's drag), or a
 *   tap on the dimmed page.
 *
 * **Focus and the keyboard.** The field is `autoFocus`ed, so it has focus in
 * the same commit that mounts the sheet — within the tap on `+`, which is what
 * lets iOS raise the keyboard for a programmatic focus (Radix's own open
 * auto-focus then sees focus already inside and leaves it; `QuickActionPanel`
 * relies on the same "focus inside the gesture" chain for the full form's
 * sheet). The sheet is a `fixed bottom-0` Sheet like every other phone sheet
 * in the app (`CreateTaskPanel`, `DetailModalShell`); none of them track
 * `visualViewport`. When the keyboard opens, iOS (Safari and the app's
 * WKWebView alike) pans the visual viewport to keep the focused field in view,
 * and because this sheet is short — one field and a link — the field lands
 * right above the keyboard.
 */
export function QuickAddSheet({ open, onOpenChange, onAdd, onOpenAddForm }: QuickAddSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl"
        showCloseButton={false}
        data-quick-add-sheet
      >
        <VisuallyHidden>
          <SheetTitle>Quick add</SheetTitle>
          <SheetDescription>Add a task in one line</SheetDescription>
        </VisuallyHidden>
        <div className="px-4 pb-3">
          <QuickAdd
            autoFocus
            manualAdd="link"
            onAdd={async (title) => {
              await onAdd(title)
            }}
            onSubmitted={() => onOpenChange(false)}
            onOpenAddForm={(title) => {
              onOpenChange(false)
              onOpenAddForm(title)
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
