'use client'

import { useCallback, useState, type ReactNode, type RefObject } from 'react'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { UnsavedChangesDialog } from '@/components/UnsavedChangesDialog'
import { useIsMobile } from '@/hooks/useIsMobile'

/**
 * The chrome every surface's Details wears: a dialog on a wide screen, a bottom
 * sheet on a phone, and one guard against closing over unsaved edits.
 *
 * Reminders and Quotas had this twice, line for line, differing only in the
 * description string — which is exactly the kind of divergence Trent called out
 * on 2026-09-06 ("why are we deviating from the other panels?"). Anything that
 * should be true of both editors is now true of both by construction: the sheet
 * height, the dialog width, the hidden accessible name, the drag-to-dismiss
 * that switches off once there are edits to lose.
 *
 * What stays with the caller is only what genuinely differs: which editor goes
 * inside, and what it is called.
 */
export function DetailModalShell({
  open,
  title,
  description,
  isDirty,
  dirtyRef,
  onClose,
  onSave,
  children,
}: {
  open: boolean
  /** Accessible name — "Quota", "New reminder", "Reminders". Never shown. */
  title: string
  /** Accessible description of what this editor changes. Never shown. */
  description: string
  /** Whether the editor holds unsaved edits. Drives the drag affordance. */
  isDirty: boolean
  /**
   * The SAME fact as `isDirty`, carried by a ref the caller writes
   * synchronously when the editor reports.
   *
   * Both are needed and neither is redundant. Radix hands a dismissal to
   * whichever onOpenChange it last captured, so a guard reading state trails
   * the editor's report by a render — an Escape pressed right after an edit
   * reached a guard that still believed the editor was clean, which is the bug
   * this ref was introduced to fix. Mirroring the prop into a ref inside an
   * effect would reintroduce it, one render later.
   */
  dirtyRef: RefObject<boolean>
  /** Close and discard. The shell asks first when there are edits to lose. */
  onClose: () => void
  /** Commit the editor's staged changes — the detail component's `saveRef`. */
  onSave: () => Promise<void> | void
  children: ReactNode
}) {
  const isMobile = useIsMobile()
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) return
      if (dirtyRef.current) setShowCloseConfirm(true)
      else onClose()
    },
    [dirtyRef, onClose],
  )

  const handleDiscardAndClose = useCallback(() => {
    setShowCloseConfirm(false)
    onClose()
  }, [onClose])

  const handleSaveAndClose = useCallback(async () => {
    await onSave()
    // A successful save closes the modal itself; a failed one leaves it open
    // with the edits, and the confirmation has served its purpose either way.
    setShowCloseConfirm(false)
  }, [onSave])

  const confirmDialog = (
    <UnsavedChangesDialog
      open={showCloseConfirm}
      onOpenChange={setShowCloseConfirm}
      onDiscard={handleDiscardAndClose}
      onSave={handleSaveAndClose}
    />
  )

  if (isMobile) {
    return (
      <>
        <Sheet open={open} onOpenChange={handleOpenChange}>
          <SheetContent
            side="bottom"
            className="max-h-[92dvh] overflow-y-auto rounded-t-2xl"
            showCloseButton={false}
            draggable={!isDirty}
          >
            <VisuallyHidden>
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </VisuallyHidden>
            <div className="px-4 pb-2">{children}</div>
          </SheetContent>
        </Sheet>
        {confirmDialog}
      </>
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="max-h-[90vh] w-[32rem] max-w-[calc(100%-2rem)] overflow-y-auto p-4"
          showCloseButton={false}
        >
          <VisuallyHidden>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </VisuallyHidden>
          <div className="min-w-0">{children}</div>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  )
}
