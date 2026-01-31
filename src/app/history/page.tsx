'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

interface CompletionEntry {
  id: number
  task_id: number
  task_title: string
  completed_at: string
  due_at_was: string | null
}

interface UndoEntry {
  id: number
  action: string
  description: string | null
  created_at: string
  undone: boolean
}

type TabId = 'completions' | 'activity'

export default function HistoryPage() {
  const { status } = useSession()
  const router = useRouter()
  const [tab, setTab] = useState<TabId>('completions')
  const [completions, setCompletions] = useState<CompletionEntry[]>([])
  const [activities, setActivities] = useState<UndoEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
      return
    }

    async function fetchData() {
      setLoading(true)
      try {
        if (tab === 'completions') {
          const res = await fetch(`/api/completions?date=${date}`)
          if (res.ok) {
            const data = await res.json()
            setCompletions(data.data?.completions || [])
          }
        } else {
          const res = await fetch('/api/undo/history?limit=50')
          if (res.ok) {
            const data = await res.json()
            setActivities(data.data?.actions || [])
          }
        }
      } catch {
        // Handled silently
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [status, router, tab, date])

  if (status === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <header className="sticky top-0 z-10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-2xl mx-auto px-4 py-3">
          <h1 className="text-xl font-semibold">History</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-6">
        {/* Tab bar */}
        <div className="flex gap-1 p-1 mb-6 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <button
            onClick={() => setTab('completions')}
            className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === 'completions'
                ? 'bg-white dark:bg-zinc-800 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            Completions
          </button>
          <button
            onClick={() => setTab('activity')}
            className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === 'activity'
                ? 'bg-white dark:bg-zinc-800 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            Activity
          </button>
        </div>

        {tab === 'completions' && (
          <div>
            {/* Date navigation */}
            <div className="flex items-center gap-3 mb-4">
              <button
                onClick={() => {
                  const d = new Date(date)
                  d.setDate(d.getDate() - 1)
                  setDate(d.toISOString().split('T')[0])
                }}
                className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                aria-label="Previous day"
              >
                &larr;
              </button>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
              />
              <button
                onClick={() => {
                  const d = new Date(date)
                  d.setDate(d.getDate() + 1)
                  setDate(d.toISOString().split('T')[0])
                }}
                className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                aria-label="Next day"
              >
                &rarr;
              </button>
            </div>

            {loading ? (
              <div className="animate-pulse text-zinc-500 text-center py-8">Loading...</div>
            ) : completions.length === 0 ? (
              <p className="text-center text-zinc-400 py-8">No completions for this date.</p>
            ) : (
              <div className="space-y-2">
                {completions.map((c) => (
                  <div
                    key={c.id}
                    className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 flex items-center gap-3"
                  >
                    <span className="text-green-500">&#x2713;</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{c.task_title}</p>
                      <p className="text-xs text-zinc-400">
                        {new Date(c.completed_at).toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                          hour12: true,
                        })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'activity' && (
          <div>
            {loading ? (
              <div className="animate-pulse text-zinc-500 text-center py-8">Loading...</div>
            ) : activities.length === 0 ? (
              <p className="text-center text-zinc-400 py-8">No activity recorded.</p>
            ) : (
              <div className="space-y-2">
                {activities.map((a) => (
                  <div
                    key={a.id}
                    className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 flex items-center gap-3"
                  >
                    <span className={a.undone ? 'text-zinc-400' : 'text-blue-500'}>
                      {a.undone ? '○' : '●'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{a.description || a.action}</p>
                      <p className="text-xs text-zinc-400">
                        {new Date(a.created_at).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          hour12: true,
                        })}
                        {a.undone && ' (undone)'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
