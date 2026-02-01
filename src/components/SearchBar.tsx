'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface SearchBarProps {
  onSearch: (query: string) => void
  onClear: () => void
}

export function SearchBar({ onSearch, onClear }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    setExpanded(false)
  }

  useEffect(() => {
    if (expanded) inputRef.current?.focus()
  }, [expanded])

  return (
    <div className="flex items-center">
      {/* Desktop: always visible */}
      <div
        className={cn(
          'hidden items-center gap-2 transition-all md:flex',
          expanded || query ? 'w-64' : 'w-48',
        )}
      >
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={() => setExpanded(true)}
            onBlur={() => {
              if (!query) setExpanded(false)
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

      {/* Mobile: icon that expands to full bar */}
      <div className="md:hidden">
        {expanded ? (
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={query}
              onChange={(e) => handleChange(e.target.value)}
              placeholder="Search..."
              className="w-40"
              autoFocus
              aria-label="Search tasks"
            />
            <Button variant="ghost" size="icon" onClick={handleClear} aria-label="Close search">
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="icon" onClick={() => setExpanded(true)} aria-label="Search">
            <Search className="size-5" />
          </Button>
        )}
      </div>
    </div>
  )
}
