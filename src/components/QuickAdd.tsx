'use client'

import { useState, useRef } from 'react'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface QuickAddProps {
  onAdd: (title: string) => void
}

export function QuickAdd({ onAdd }: QuickAddProps) {
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = async () => {
    const trimmed = title.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    try {
      onAdd(trimmed)
      setTitle('')
      inputRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mb-6">
      <div className={cn(
        "flex items-center gap-2 p-3 rounded-lg border bg-card",
        "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
        "transition-all"
      )}>
        <Plus className="size-5 text-muted-foreground flex-shrink-0" />
        <Input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder="Add a task..."
          className="flex-1 border-0 shadow-none focus-visible:ring-0 p-0 h-auto"
          aria-label="Quick add task"
          disabled={submitting}
        />
      </div>
    </div>
  )
}
