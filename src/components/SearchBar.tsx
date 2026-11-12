'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { TAB_RETAP_SEARCH_EVENT } from '@/hooks/useTabRetap'

interface SearchBarProps {
  onSearch: (query: string) => void
  onClear: () => void
  onExpandedChange?: (expanded: boolean) => void
  focusRef?: React.MutableRefObject<(() => void) | null>
  /** What this bar searches, for the placeholder and the label. Default: tasks. */
  subject?: string
  /**
   * A search the page arrived with (`/?search=`, the Reminders and Quotas
   * tabs' "show them"): the field starts holding it (shown on a phone too),
   * without the focus. The page runs the search itself; this is only the text.
   */
  initialQuery?: string
}

export function SearchBar({
  onSearch,
  onClear,
  onExpandedChange,
  focusRef,
  subject = 'tasks',
  initialQuery = '',
}: SearchBarProps) {
  const [query, setQuery] = useState(initialQuery)
  const [expanded, setExpanded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    [],
  )

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

  const handleClear = useCallback(() => {
    setQuery('')
    onClear()
    setExpandedState(false)
  }, [onClear, setExpandedState])

  useRetapClears(query, debounceRef, handleClear)

  useEffect(() => {
    if (expanded) inputRef.current?.focus()
  }, [expanded])

  // Register imperative focus callback for Cmd+K shortcut
  useEffect(() => {
    if (focusRef) {
      focusRef.current = () => {
        setExpandedState(true)
        inputRef.current?.focus()
      }
      return () => {
        focusRef.current = null
      }
    }
  }, [focusRef, setExpandedState])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (query) {
          handleClear()
        } else {
          ;(e.target as HTMLElement).blur()
          setExpandedState(false)
        }
      }
    },
    [query, handleClear, setExpandedState],
  )

  const isActive = expanded || !!query

  return (
    // ml-auto keeps search right-aligned; flex-1 when active gives room for leftward growth
    // shrink-0 on a phone: the icon button is all there is, and squeezing it
    // only pushed it over the header's section label (see `Header`).
    <div className="flex min-w-0 shrink-0 items-center justify-end md:flex-1 md:shrink">
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
            onKeyDown={handleKeyDown}
            placeholder={`Search ${subject}...`}
            className="pr-8 pl-9"
            aria-label={`Search ${subject}`}
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
        {/* Holding text counts as open: a search the page arrived with
            (`initialQuery`) shows in the field without taking the focus. */}
        {expanded || query ? (
          <div className="animate-fade-in bg-background absolute inset-y-0 right-14 left-4 z-20 flex items-center gap-1">
            <Input
              type="text"
              value={query}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search..."
              className="min-w-0 flex-1"
              autoFocus={expanded}
              aria-label={`Search ${subject}`}
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

/**
 * A re-tap of this page's own tab clears an active search, and that is all
 * the tap does (`useTabRetap`, Trent 2026-11-12). With no text the event is
 * left alone and the re-tap scrolls as usual. A search still inside its
 * debounce is dropped with the text.
 */
function useRetapClears(
  query: string,
  debounceRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  clear: () => void,
) {
  useEffect(() => {
    if (!query) return
    const onRetap = (e: Event) => {
      e.preventDefault()
      if (debounceRef.current) clearTimeout(debounceRef.current)
      clear()
    }
    window.addEventListener(TAB_RETAP_SEARCH_EVENT, onRetap)
    return () => window.removeEventListener(TAB_RETAP_SEARCH_EVENT, onRetap)
  }, [query, debounceRef, clear])
}
