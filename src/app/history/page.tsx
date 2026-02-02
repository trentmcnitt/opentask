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
      <div className="flex flex-1 items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <h1 className="text-xl font-semibold">History</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        {/* Tab bar */}
        <div className="mb-6 flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
          <button
            onClick={() => setTab('completions')}
            className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
              tab === 'completions'
                ? 'bg-white shadow-sm dark:bg-zinc-800'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            Completions
          </button>
          <button
            onClick={() => setTab('activity')}
            className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
              tab === 'activity'
                ? 'bg-white shadow-sm dark:bg-zinc-800'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            Activity
          </button>
        </div>

        {tab === 'completions' && (
          <CompletionsTab
            date={date}
            setDate={setDate}
            loading={loading}
            completions={completions}
          />
        )}

        {tab === 'activity' && <ActivityTab loading={loading} activities={activities} />}
      </main>
    </div>
  )
}

function CompletionsTab({
  date,
  setDate,
  loading,
  completions,
}: {
  date: string
  setDate: (d: string) => void
  loading: boolean
  completions: CompletionEntry[]
}) {
  return (
    <div>
      {/* Date navigation */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => {
            const d = new Date(date)
            d.setDate(d.getDate() - 1)
            setDate(d.toISOString().split('T')[0])
          }}
          className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Previous day"
        >
          &larr;
        </button>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
        />
        <button
          onClick={() => {
            const d = new Date(date)
            d.setDate(d.getDate() + 1)
            setDate(d.toISOString().split('T')[0])
          }}
          className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Next day"
        >
          &rarr;
        </button>
      </div>

      {loading ? (
        <div className="animate-pulse py-8 text-center text-zinc-500">Loading...</div>
      ) : completions.length === 0 ? (
        <p className="py-8 text-center text-zinc-400">No completions for this date.</p>
      ) : (
        <div className="space-y-2">
          {completions.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <span className="text-green-500">&#x2713;</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.task_title}</p>
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
  )
}

function ActivityTab({ loading, activities }: { loading: boolean; activities: UndoEntry[] }) {
  return (
    <div>
      {loading ? (
        <div className="animate-pulse py-8 text-center text-zinc-500">Loading...</div>
      ) : activities.length === 0 ? (
        <p className="py-8 text-center text-zinc-400">No activity recorded.</p>
      ) : (
        <div className="space-y-2">
          {activities.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <span className={a.undone ? 'text-zinc-400' : 'text-blue-500'}>
                {a.undone ? '○' : '●'}
              </span>
              <div className="min-w-0 flex-1">
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
  )
}
