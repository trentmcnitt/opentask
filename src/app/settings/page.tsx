'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useLabelConfig, usePriorityDisplay } from '@/components/LabelConfigProvider'
import { Switch } from '@/components/ui/switch'
import { LABEL_COLORS, LABEL_COLOR_NAMES } from '@/lib/label-colors'
import { showToast } from '@/lib/toast'
import { BUILD_ID, formatBuildDate } from '@/lib/build-info'
import type { LabelColor, LabelConfig, PriorityDisplayConfig } from '@/types'

export default function SettingsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  // Default grouping state - hidden but preserved for future use
  // const [defaultGrouping, setDefaultGrouping] = useState<'time' | 'project'>('project')
  const { labelConfig, setLabelConfig } = useLabelConfig()
  const { priorityDisplay, setPriorityDisplay } = usePriorityDisplay()

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/user/preferences')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        // Default grouping loading - hidden but preserved for future use
        // if (data?.data?.default_grouping) {
        //   setDefaultGrouping(data.data.default_grouping)
        // }
        if (data?.data?.label_config) {
          setLabelConfig(data.data.label_config)
        }
        if (data?.data?.priority_display) {
          setPriorityDisplay(data.data.priority_display)
        }
      })
      .catch(() => {})
  }, [status, setLabelConfig, setPriorityDisplay])

  // handleGroupingChange - hidden but preserved for future use
  // const handleGroupingChange = async (value: 'time' | 'project') => {
  //   const prev = defaultGrouping
  //   setDefaultGrouping(value)
  //   try {
  //     const res = await fetch('/api/user/preferences', {
  //       method: 'PATCH',
  //       headers: { 'Content-Type': 'application/json' },
  //       body: JSON.stringify({ default_grouping: value }),
  //     })
  //     if (!res.ok) throw new Error('Failed to save')
  //     showToast({ message: 'Preference saved' })
  //   } catch {
  //     setDefaultGrouping(prev)
  //     showToast({ message: 'Failed to save preference' })
  //   }
  // }

  const saveLabelConfig = async (newConfig: LabelConfig[]) => {
    const prev = labelConfig
    setLabelConfig(newConfig)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label_config: newConfig }),
      })
      if (!res.ok) throw new Error('Failed to save')
      showToast({ message: 'Labels saved' })
    } catch {
      setLabelConfig(prev)
      showToast({ message: 'Failed to save labels' })
    }
  }

  const handlePriorityDisplayChange = async (key: keyof PriorityDisplayConfig, value: boolean) => {
    const prev = priorityDisplay
    const newConfig = { ...priorityDisplay, [key]: value }
    setPriorityDisplay(newConfig)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority_display: newConfig }),
      })
      if (!res.ok) throw new Error('Failed to save')
      showToast({ message: 'Preference saved' })
    } catch {
      setPriorityDisplay(prev)
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

        {/* Default Grouping preference - hidden but preserved for future use
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
        */}

        {/* Priority Display */}
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-3 text-sm font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
            Priority Display
          </h2>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
            Configure how task priorities are shown in the task list.
          </p>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">Show dot indicator</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Display a colored dot after Medium/Low priority task titles
                </div>
              </div>
              <Switch
                checked={priorityDisplay.trailingDot}
                onCheckedChange={(checked) => handlePriorityDisplayChange('trailingDot', checked)}
                aria-label="Show dot indicator"
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">Color task titles</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Color the task title text based on priority level
                </div>
              </div>
              <Switch
                checked={priorityDisplay.colorTitle}
                onCheckedChange={(checked) => handlePriorityDisplayChange('colorTitle', checked)}
                aria-label="Color task titles"
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">Show right border</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Display a colored right border based on priority
                </div>
              </div>
              <Switch
                checked={priorityDisplay.rightBorder}
                onCheckedChange={(checked) => handlePriorityDisplayChange('rightBorder', checked)}
                aria-label="Show right border"
              />
            </div>
          </div>
        </section>

        {/* Labels */}
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-3 text-sm font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
            Labels
          </h2>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
            Define labels with colors. Predefined labels display their color everywhere.
          </p>
          <LabelEditor labels={labelConfig} onSave={saveLabelConfig} />
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

        {/* About */}
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-3 text-sm font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
            About
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Version</span>
              <span>0.1.0</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Build</span>
              <span>{formatBuildDate(BUILD_ID)}</span>
            </div>
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

function ColorDot({
  color,
  selected,
  onClick,
  ariaLabel,
}: {
  color: LabelColor
  selected: boolean
  onClick: () => void
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`size-5 rounded-full ${LABEL_COLORS[color].dot} transition-transform ${
        selected
          ? 'ring-2 ring-zinc-400 ring-offset-1 ring-offset-white dark:ring-offset-zinc-950'
          : 'hover:scale-110'
      }`}
      aria-label={ariaLabel}
    />
  )
}

function LabelEditor({
  labels,
  onSave,
}: {
  labels: LabelConfig[]
  onSave: (labels: LabelConfig[]) => void
}) {
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<LabelColor>('blue')

  const handleAdd = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    if (labels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) {
      showToast({ message: 'Label already exists' })
      return
    }
    onSave([...labels, { name: trimmed, color: newColor }])
    setNewName('')
  }

  const handleRemove = (name: string) => {
    onSave(labels.filter((l) => l.name !== name))
  }

  const handleRecolor = (name: string, color: LabelColor) => {
    onSave(labels.map((l) => (l.name === name ? { ...l, color } : l)))
  }

  return (
    <div className="space-y-2">
      {labels.map((label) => (
        <div key={label.name} className="flex items-center gap-2">
          <Badge
            className={`${LABEL_COLORS[label.color].bg} ${LABEL_COLORS[label.color].text} flex-shrink-0 border-0`}
          >
            {label.name}
          </Badge>
          <div className="flex flex-1 items-center gap-1">
            {LABEL_COLOR_NAMES.map((c) => (
              <ColorDot
                key={c}
                color={c}
                selected={label.color === c}
                onClick={() => handleRecolor(label.name, c)}
                ariaLabel={`Set ${label.name} to ${LABEL_COLORS[c].display}`}
              />
            ))}
          </div>
          <button
            onClick={() => handleRemove(label.name)}
            className="text-zinc-400 transition-colors hover:text-red-500"
            aria-label={`Remove ${label.name}`}
          >
            <X className="size-4" />
          </button>
        </div>
      ))}

      {/* Add new label row */}
      <div className="flex items-center gap-2 pt-1">
        <Input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
          placeholder="New label"
          className="h-8 w-32 text-sm"
        />
        <div className="flex items-center gap-1">
          {LABEL_COLOR_NAMES.map((c) => (
            <ColorDot
              key={c}
              color={c}
              selected={newColor === c}
              onClick={() => setNewColor(c)}
              ariaLabel={`${LABEL_COLORS[c].display} color`}
            />
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleAdd}
          disabled={!newName.trim()}
          className="h-8"
        >
          Add
        </Button>
      </div>
    </div>
  )
}
