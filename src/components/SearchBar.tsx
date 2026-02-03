'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface SearchBarProps {
  onSearch: (query: string) => void
  onClear: () => void
  onExpandedChange?: (expanded: boolean) => void
}

export function SearchBar({ onSearch, onClear, onExpandedChange }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setExpandedState = useCallback(
    (value: boolean) => {
      setExpanded(value)
      onExpandedChange?.(value)
    },
    [onExpandedChange],
  )

  const handleChange = useCallback(
    (value: string) => {
      setQuery(value)
      if (debounceRef.current) clearTimeout(debounceRef.current)

      if (!value.trim()) {
        onClear()
        return
      }

      debounceRef.current = setTimeout(() => {
        onSearch(value.trim())
      }, 200)
    },
    [onSearch, onClear],
  )

  const handleClear = () => {
    setQuery('')
    onClear()
    setExpandedState(false)
  }

  useEffect(() => {
    if (expanded) inputRef.current?.focus()
  }, [expanded])

  const isActive = expanded || !!query

  return (
    // ml-auto keeps search right-aligned; flex-1 when active gives room for leftward growth
    <div className="flex min-w-0 flex-1 items-center justify-end">
      {/* Desktop: ml-4 (16px) for spacing from badges - matches 16px visual gap to clock icon */}
      <div
        className={cn(
          'ml-4 hidden flex-1 items-center transition-[width] duration-200 ease-in-out md:flex',
          isActive ? 'bg-background relative z-10' : '',
        )}
      >
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={() => setExpandedState(true)}
            onBlur={() => {
              if (!query) setExpandedState(false)
            }}
            placeholder="Search tasks..."
            className="pr-8 pl-9"
            aria-label="Search tasks"
          />
          {query && (
            <button
              onClick={handleClear}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
              aria-label="Clear search"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* Mobile: icon button, or absolute overlay when expanded */}
      {/* -mr-2.5 compensates for parent gap + extra space to match clock-hamburger spacing */}
      <div className="-mr-2.5 md:hidden">
        {expanded ? (
          <div className="animate-fade-in bg-background absolute inset-y-0 right-14 left-4 z-20 flex items-center gap-1">
            <Input
              type="text"
              value={query}
              onChange={(e) => handleChange(e.target.value)}
              placeholder="Search..."
              className="min-w-0 flex-1"
              autoFocus
              aria-label="Search tasks"
            />
            <button
              onClick={handleClear}
              className="text-muted-foreground hover:text-foreground flex-shrink-0 p-1"
              aria-label="Close search"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setExpandedState(true)}
            aria-label="Search"
          >
            <Search className="size-5" />
          </Button>
        )}
      </div>
    </div>
  )
}
