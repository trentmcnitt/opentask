'use client'

import { createContext, useContext } from 'react'
import { useSelectionMode } from '@/hooks/useSelectionMode'

interface SelectionContextType {
  selectedIds: Set<number>
  anchor: number | null
  isSelectionMode: boolean
  toggle: (id: number) => void
  rangeSelect: (id: number, orderedIds: number[]) => void
  selectAll: (ids: number[]) => void
  clear: () => void
}

const SelectionContext = createContext<SelectionContextType | null>(null)

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const selection = useSelectionMode()

  return <SelectionContext.Provider value={selection}>{children}</SelectionContext.Provider>
}

export function useSelection() {
  const context = useContext(SelectionContext)
  if (!context) {
    throw new Error('useSelection must be used within SelectionProvider')
  }
  return context
}
