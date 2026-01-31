'use client'

import { useState } from 'react'

interface FloatingActionBarProps {
  selectedCount: number
  onDone: () => void
  onSnooze1h: () => void
  onSnooze2h: () => void
  onSnoozeTomorrow: () => void
  onDelete: () => void
  onPriorityHigh: () => void
  onPriorityLow: () => void
  onClear: () => void
}

export function FloatingActionBar({
  selectedCount,
  onDone,
  onSnooze1h,
  onSnooze2h,
  onSnoozeTomorrow,
  onDelete,
  onPriorityHigh,
  onPriorityLow,
  onClear,
}: FloatingActionBarProps) {
  const [showOverflow, setShowOverflow] = useState(false)

  if (selectedCount === 0) return null

  return (
    <>
      {/* Overflow menu backdrop */}
      {showOverflow && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setShowOverflow(false)}
          aria-hidden="true"
        />
      )}

      <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 animate-slide-up">
        <div className="flex items-center gap-2 px-4 py-3 bg-zinc-900 dark:bg-zinc-100 rounded-xl shadow-xl">
          <span className="text-sm font-medium text-white dark:text-zinc-900 mr-2">
            {selectedCount} selected
          </span>

          <ActionButton label="Done" onClick={onDone} className="bg-green-600 hover:bg-green-700 text-white" />
          <ActionButton label="+1h" onClick={onSnooze1h} className="bg-blue-600 hover:bg-blue-700 text-white" />
          <ActionButton label="+2h" onClick={onSnooze2h} className="bg-blue-600 hover:bg-blue-700 text-white" />
          <ActionButton label="9AM" onClick={onSnoozeTomorrow} className="bg-blue-600 hover:bg-blue-700 text-white" />

          {/* Overflow menu */}
          <div className="relative">
            <button
              onClick={() => setShowOverflow(!showOverflow)}
              className="px-2 py-1.5 rounded-lg bg-zinc-700 dark:bg-zinc-300 hover:bg-zinc-600 dark:hover:bg-zinc-400 text-white dark:text-zinc-900 text-sm font-medium"
              aria-label="More actions"
            >
              &middot;&middot;&middot;
            </button>

            {showOverflow && (
              <div className="absolute bottom-full mb-2 right-0 w-40 bg-white dark:bg-zinc-900 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 py-1">
                <OverflowItem label="Priority: High" onClick={() => { onPriorityHigh(); setShowOverflow(false) }} />
                <OverflowItem label="Priority: Low" onClick={() => { onPriorityLow(); setShowOverflow(false) }} />
                <OverflowItem label="Delete" onClick={() => { onDelete(); setShowOverflow(false) }} className="text-red-500" />
              </div>
            )}
          </div>

          <button
            onClick={onClear}
            className="ml-2 p-1 text-zinc-400 dark:text-zinc-600 hover:text-white dark:hover:text-zinc-900"
            aria-label="Clear selection"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </>
  )
}

function ActionButton({ label, onClick, className }: { label: string; onClick: () => void; className: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium ${className}`}
    >
      {label}
    </button>
  )
}

function OverflowItem({ label, onClick, className = '' }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ${className}`}
    >
      {label}
    </button>
  )
}
