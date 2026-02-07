'use client'

import * as React from 'react'
import * as SheetPrimitive from '@radix-ui/react-dialog'
import { useDrag } from '@use-gesture/react'
import { XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

const SheetContext = React.createContext<{
  open?: boolean
  onOpenChange?: (open: boolean) => void
}>({})

function Sheet({ open, onOpenChange, ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return (
    <SheetContext.Provider value={{ open, onOpenChange }}>
      <SheetPrimitive.Root data-slot="sheet" open={open} onOpenChange={onOpenChange} {...props} />
    </SheetContext.Provider>
  )
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Drag-to-dismiss handle for bottom sheets. Rendered automatically by SheetContent
 * when side="bottom" and draggable is not false. The user drags down on the handle
 * area; releasing past a threshold (30% of sheet height, capped at 150px) dismisses
 * the sheet. Releasing below the threshold snaps back.
 *
 * The drag is handle-only (touch-none on the handle div) so it never conflicts
 * with scrollable content inside the sheet.
 *
 * On drag-dismiss, the sheet animates off-screen via inline transform, then calls
 * onOpenChange(false). Radix's exit animation runs while the sheet is already
 * off-screen (the inline transform overrides the CSS animation's transform),
 * so there's no visible snap-back. Radix's state machine completes normally,
 * allowing the sheet to reopen.
 */
function DragHandle({ onDismiss }: { onDismiss: () => void }) {
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [dragOffset, setDragOffset] = React.useState(0)
  const [isDragging, setIsDragging] = React.useState(false)

  const bind = useDrag(
    ({ movement: [, my], down }) => {
      // Only allow downward drag (positive y)
      const clamped = Math.max(0, my)

      if (down) {
        setIsDragging(true)
        setDragOffset(clamped)
      } else {
        // Released — check threshold
        const sheetEl = contentRef.current?.closest('[data-slot="sheet-content"]') as HTMLElement
        const sheetHeight = sheetEl?.offsetHeight || 400
        const threshold = Math.min(sheetHeight * 0.3, 150)

        if (clamped > threshold) {
          // Animate off-screen (use viewport height to ensure fully hidden),
          // then dismiss. The inline transform keeps the sheet off-screen while
          // Radix plays its exit animation, so no visual snap-back occurs.
          setDragOffset(window.innerHeight)
          setIsDragging(false)
          setTimeout(() => {
            onDismiss()
          }, 200)
        } else {
          // Snap back
          setDragOffset(0)
          setIsDragging(false)
        }
      }
    },
    {
      axis: 'y',
      filterTaps: true,
    },
  )

  // Apply translateY to the parent SheetContent element so the entire sheet
  // moves during drag. Inline styles are cleaned up automatically when Radix
  // unmounts the portal on close.
  React.useEffect(() => {
    const sheetEl = contentRef.current?.closest('[data-slot="sheet-content"]') as HTMLElement
    if (!sheetEl) return

    if (dragOffset > 0) {
      sheetEl.style.transform = `translateY(${dragOffset}px)`
      sheetEl.style.transition = isDragging ? 'none' : 'transform 0.2s ease-out'
    } else {
      sheetEl.style.transform = ''
      sheetEl.style.transition = ''
    }
  }, [dragOffset, isDragging])

  return (
    <div
      ref={contentRef}
      className="flex cursor-grab items-center justify-center py-3 active:cursor-grabbing"
      {...bind()}
      style={{ touchAction: 'none' }}
    >
      <div className="bg-muted-foreground/30 h-1.5 w-12 rounded-full" />
    </div>
  )
}

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  draggable = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left'
  showCloseButton?: boolean
  draggable?: boolean
}) {
  const { onOpenChange } = React.useContext(SheetContext)
  const showDragHandle = side === 'bottom' && draggable

  const handleDragDismiss = React.useCallback(() => {
    onOpenChange?.(false)
  }, [onOpenChange])

  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500',
          side === 'right' &&
            'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm',
          side === 'left' &&
            'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm',
          side === 'top' &&
            'data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto border-b',
          side === 'bottom' &&
            'data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 h-auto border-t',
          className,
        )}
        {...props}
      >
        {showDragHandle && <DragHandle onDismiss={handleDragDismiss} />}
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close className="ring-offset-background focus:ring-ring data-[state=open]:bg-secondary absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1.5 p-4', className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-foreground font-semibold', className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
