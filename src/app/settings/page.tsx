'use client'

import Link from 'next/link'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'
import { showToast } from '@/lib/toast'

export default function SettingsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [defaultGrouping, setDefaultGrouping] = useState<'time' | 'project'>('project')

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/user/preferences')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.data?.default_grouping) {
          setDefaultGrouping(data.data.default_grouping)
        }
      })
      .catch(() => {})
  }, [status])

  const handleGroupingChange = async (value: 'time' | 'project') => {
    const prev = defaultGrouping
    setDefaultGrouping(value)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_grouping: value }),
      })
      if (!res.ok) throw new Error('Failed to save')
      showToast({ message: 'Preference saved' })
    } catch {
      setDefaultGrouping(prev)
      showToast({ message: 'Failed to save preference' })
    }
  }

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
          <h1 className="text-xl font-semibold">Settings</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl space-y-6 px-4 py-6">
        {/* Account info */}
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-3 text-sm font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
            Account
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Name</span>
              <span>{session?.user?.name || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Email</span>
              <span>{session?.user?.email || '-'}</span>
            </div>
          </div>
        </section>

        {/* Preferences */}
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-3 text-sm font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
            Preferences
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Default grouping</span>
              <select
                value={defaultGrouping}
                onChange={(e) => handleGroupingChange(e.target.value as 'time' | 'project')}
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="project">By project</option>
                <option value="time">By time</option>
              </select>
            </div>
          </div>
        </section>

        {/* Navigation links (mobile access to Archive & Trash) */}
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-3 text-sm font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
            More
          </h2>
          <div className="space-y-1">
            <Link
              href="/archive"
              className="-mx-2 flex items-center justify-between rounded-lg p-2 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className="text-sm">Archive</span>
              <span className="text-xs text-zinc-400">&rsaquo;</span>
            </Link>
            <Link
              href="/trash"
              className="-mx-2 flex items-center justify-between rounded-lg p-2 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className="text-sm">Trash</span>
              <span className="text-xs text-zinc-400">&rsaquo;</span>
            </Link>
          </div>
        </section>

        {/* Sign out */}
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="w-full rounded-lg border border-red-200 p-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
        >
          Sign Out
        </button>
      </main>
    </div>
  )
}
