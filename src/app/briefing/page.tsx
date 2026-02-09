'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Loader2, RefreshCw, CheckCircle2, Circle, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { BriefingResult } from '@/core/ai/types'

function BriefingHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
      <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          <h1 className="text-xl font-semibold">Daily Briefing</h1>
        </div>
        {children}
      </div>
    </header>
  )
}

function BriefingSkeleton() {
  return (
    <div className="flex-1">
      <BriefingHeader />
      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <div className="space-y-4">
          <div className="h-8 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <div className="h-5 w-1/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-4 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
                <div className="h-4 w-5/6 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  )
}

/**
 * Daily Briefing page — AI-generated overview of the user's tasks.
 *
 * Renders a structured briefing with greeting, sections, and actionable
 * items. Items with task_id + actionable=true get a checkbox that marks
 * the task done via the API.
 */
export default function BriefingPage() {
  const { status } = useSession()
  const router = useRouter()
  const [briefing, setBriefing] = useState<BriefingResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [completedIds, setCompletedIds] = useState<Set<number>>(new Set())
  const briefingRef = useRef(briefing)
  briefingRef.current = briefing

  const fetchBriefing = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)

    try {
      const url = refresh ? '/api/ai/briefing?refresh=true' : '/api/ai/briefing'
      const res = await fetch(url)
      if (!res.ok) throw new Error('Failed to fetch briefing')
      const json = await res.json()
      if (json.data) {
        setBriefing(json.data)
      }
    } catch {
      if (!briefingRef.current) {
        toast.error('Failed to generate briefing')
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
      return
    }
    fetchBriefing()
  }, [status, router, fetchBriefing])

  const handleDone = async (taskId: number) => {
    setCompletedIds((prev) => new Set([...prev, taskId]))
    try {
      const res = await fetch(`/api/tasks/${taskId}/done`, { method: 'POST' })
      if (!res.ok) {
        setCompletedIds((prev) => {
          const next = new Set(prev)
          next.delete(taskId)
          return next
        })
        toast.error('Failed to complete task')
      }
    } catch {
      setCompletedIds((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }

  if (status === 'loading' || loading) return <BriefingSkeleton />

  return (
    <div className="flex-1">
      <BriefingHeader>
        <button
          onClick={() => fetchBriefing(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-950/30"
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </button>
      </BriefingHeader>

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        {!briefing ? (
          <div className="py-12 text-center">
            <Sparkles className="mx-auto h-12 w-12 text-zinc-300 dark:text-zinc-700" />
            <p className="text-muted-foreground mt-4">No briefing available yet.</p>
            <button
              onClick={() => fetchBriefing(true)}
              className="mt-2 text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              Generate one now
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <p className="text-lg text-zinc-700 dark:text-zinc-300">{briefing.greeting}</p>

            {briefing.sections.map((section, idx) => (
              <div key={idx}>
                <h2 className="mb-2 text-sm font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                  {section.heading}
                </h2>
                <div className="space-y-1">
                  {section.items.map((item, itemIdx) => (
                    <div
                      key={itemIdx}
                      className="flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                    >
                      {item.actionable && item.task_id ? (
                        <button
                          onClick={() => handleDone(item.task_id!)}
                          className="mt-0.5 shrink-0"
                          disabled={completedIds.has(item.task_id)}
                        >
                          {completedIds.has(item.task_id) ? (
                            <CheckCircle2 className="h-5 w-5 text-green-500" />
                          ) : (
                            <Circle className="h-5 w-5 text-zinc-300 hover:text-blue-500 dark:text-zinc-600" />
                          )}
                        </button>
                      ) : (
                        <span className="mt-0.5 inline-block h-5 w-5 shrink-0" />
                      )}
                      <span
                        className={`text-sm ${
                          item.task_id && completedIds.has(item.task_id)
                            ? 'text-zinc-400 line-through dark:text-zinc-600'
                            : 'text-zinc-700 dark:text-zinc-300'
                        }`}
                      >
                        {item.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {briefing.generated_at && (
              <p className="text-xs text-zinc-400 dark:text-zinc-600">
                Generated {new Date(briefing.generated_at).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
