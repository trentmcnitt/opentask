'use client'

import type { ReactNode } from 'react'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/useIsMobile'

/**
 * The Process modal's chrome: `DetailModalShell`'s — a dialog on a wide
 * screen, a bottom sheet on a phone, the same sizes — with two differences,
 * both because Process stays open while its toasts come and go:
 *
 * - No unsaved-changes guard: every tap in Process writes at once.
 * - A tap on a toast (its Undo) is not an "outside" tap. Radix closes a modal
 *   on any pointer-down outside it, and the toaster lives outside the dialog,
 *   so without this an Undo would close Process. (The toasts also need
 *   `pointer-events: auto` under a modal — see `ui/sonner.tsx`.)
 *
 * `data-blocks-page-keys` keeps the dashboard's global shortcuts (Backspace
 * trashes its selection) from acting behind the modal (`useDashboardKeyboard`).
 */
export function ProcessShell({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  const isMobile = useIsMobile()
  const onOpenChange = (next: boolean) => {
    if (!next) onClose()
  }
  const keepOpenForToasts = (e: { target: EventTarget | null; preventDefault: () => void }) => {
    if ((e.target as Element | null)?.closest?.('[data-sonner-toaster]')) e.preventDefault()
  }
  const title = 'Process'
  const description = 'Sort the Inbox, find duplicates, grow horizons and clear old targets'

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[92dvh] overflow-y-auto rounded-t-2xl"
          showCloseButton={false}
          onInteractOutside={keepOpenForToasts}
          data-blocks-page-keys
        >
          <VisuallyHidden>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </VisuallyHidden>
          <div className="px-4 pb-2">{children}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] w-[32rem] max-w-[calc(100%-2rem)] overflow-y-auto p-4"
        showCloseButton={false}
        onInteractOutside={keepOpenForToasts}
        data-blocks-page-keys
      >
        <VisuallyHidden>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </VisuallyHidden>
        <div className="min-w-0">{children}</div>
      </DialogContent>
    </Dialog>
  )
}
