'use client'

import { createContext } from 'react'

/**
 * True inside a modal Dialog or Sheet's content (`DialogContent`,
 * `SheetContent` provide it).
 *
 * Why it exists (Trent, 11-04, the Target picker in task details): a modal
 * Radix Dialog locks scrolling with react-remove-scroll, which cancels every
 * wheel and touchmove event outside the dialog's own content. A Popover is
 * portaled to <body>, so it is outside — its content could be dragged by the
 * scrollbar but never scrolled by the wheel or a finger. DropdownMenu and
 * Select take a lock of their own and were never affected; a (non-modal)
 * Popover takes none. `PopoverContent` reads this and, inside a dialog,
 * takes its own lock, which becomes the active one while it is open.
 */
export const InsideScrollLock = createContext(false)
