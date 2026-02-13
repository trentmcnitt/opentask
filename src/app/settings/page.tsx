'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  useLabelConfig,
  usePriorityDisplay,
  useAutoSnoozeDefault,
  useSnoozePreferences,
  useSchedulePreferences,
  useAiContext,
  useAiPreferences,
} from '@/components/PreferencesProvider'
import type { BubbleModel } from '@/components/PreferencesProvider'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { LABEL_COLORS, LABEL_COLOR_NAMES } from '@/lib/label-colors'
import { showToast } from '@/lib/toast'
import { BUILD_ID, formatBuildDate } from '@/lib/build-info'
import { formatSnoozeOptionLabel, formatMorningTime } from '@/lib/snooze'
import type { LabelColor, LabelConfig, PriorityDisplayConfig } from '@/types'

export default function SettingsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const { labelConfig, setLabelConfig } = useLabelConfig()
  const { priorityDisplay, setPriorityDisplay } = usePriorityDisplay()
  const { autoSnoozeDefault, setAutoSnoozeDefault } = useAutoSnoozeDefault()
  const { defaultSnoozeOption, setDefaultSnoozeOption, morningTime, setMorningTime } =
    useSnoozePreferences()
  const { wakeTime, setWakeTime, sleepTime, setSleepTime } = useSchedulePreferences()
  const { aiContext, setAiContext } = useAiContext()
  const { aiBubbleModel, setAiBubbleModel } = useAiPreferences()
  const [aiContextDraft, setAiContextDraft] = useState('')
  const [aiContextSynced, setAiContextSynced] = useState(false)
  const [customSnoozeMinutes, setCustomSnoozeMinutes] = useState('')
  const [showCustomSnooze, setShowCustomSnooze] = useState(false)

  // Sync draft from loaded preference (once, when a non-null value first arrives)
  useEffect(() => {
    if (!aiContextSynced && aiContext !== null) {
      setAiContextDraft(aiContext)
      setAiContextSynced(true)
    }
  }, [aiContext, aiContextSynced])

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

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

  const handleAutoSnoozeChange = async (value: number) => {
    const prev = autoSnoozeDefault
    setAutoSnoozeDefault(value)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_snooze_minutes: value }),
      })
      if (!res.ok) throw new Error('Failed to save')
      showToast({ message: 'Preference saved' })
    } catch {
      setAutoSnoozeDefault(prev)
      showToast({ message: 'Failed to save preference' })
    }
  }

  const handleDefaultSnoozeChange = async (value: string) => {
    const prev = defaultSnoozeOption
    setDefaultSnoozeOption(value)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_snooze_option: value }),
      })
      if (!res.ok) throw new Error('Failed to save')
      showToast({ message: 'Preference saved' })
    } catch {
      setDefaultSnoozeOption(prev)
      showToast({ message: 'Failed to save preference' })
    }
  }

  const handleMorningTimeChange = async (value: string) => {
    const prev = morningTime
    setMorningTime(value)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ morning_time: value }),
      })
      if (!res.ok) throw new Error('Failed to save')
      showToast({ message: 'Preference saved' })
    } catch {
      setMorningTime(prev)
      showToast({ message: 'Failed to save preference' })
    }
  }

  const handleWakeTimeChange = async (value: string) => {
    const prev = wakeTime
    setWakeTime(value)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wake_time: value }),
      })
      if (!res.ok) throw new Error('Failed to save')
      showToast({ message: 'Preference saved' })
    } catch {
      setWakeTime(prev)
      showToast({ message: 'Failed to save preference' })
    }
  }

  const handleSleepTimeChange = async (value: string) => {
    const prev = sleepTime
    setSleepTime(value)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sleep_time: value }),
      })
      if (!res.ok) throw new Error('Failed to save')
      showToast({ message: 'Preference saved' })
    } catch {
      setSleepTime(prev)
      showToast({ message: 'Failed to save preference' })
    }
  }

  const aiContextDirty = aiContextDraft !== (aiContext ?? '')

  const handleAiContextSave = async () => {
    const newValue = aiContextDraft.trim() || null
    const prev = aiContext
    setAiContext(newValue)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_context: newValue }),
      })
      if (!res.ok) throw new Error('Failed to save')
      showToast({ message: 'AI context saved' })
    } catch {
      setAiContext(prev)
      showToast({ message: 'Failed to save AI context' })
    }
  }

  const handleBubbleModelChange = async (value: BubbleModel) => {
    const prev = aiBubbleModel
    setAiBubbleModel(value)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_bubble_model: value }),
      })
      if (!res.ok) throw new Error('Failed to save')
      showToast({ message: 'Preference saved' })
    } catch {
      setAiBubbleModel(prev)
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
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
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

        {/* Notifications */}
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-3 text-sm font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
            Notifications
          </h2>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm">Auto-snooze interval</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                How often to repeat notifications for overdue tasks
              </div>
            </div>
            <select
              value={autoSnoozeDefault}
              onChange={(e) => handleAutoSnoozeChange(Number(e.target.value))}
              className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value={1}>1 min</option>
              <option value={5}>5 min</option>
              <option value={10}>10 min</option>
              <option value={15}>15 min</option>
              <option value={30}>30 min</option>
              <option value={60}>1 hour</option>
            </select>
          </div>
        </section>

        {/* Snooze */}
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-3 text-sm font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
            Snooze
          </h2>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
            Configure the default snooze duration and morning start time.
          </p>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">Default snooze</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Duration used for single-tap snooze
                </div>
              </div>
              {showCustomSnooze ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={1440}
                    value={customSnoozeMinutes}
                    onChange={(e) => setCustomSnoozeMinutes(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const val = parseInt(customSnoozeMinutes, 10)
                        if (val >= 1 && val <= 1440) {
                          handleDefaultSnoozeChange(String(val))
                          setShowCustomSnooze(false)
                        }
                      }
                      if (e.key === 'Escape') setShowCustomSnooze(false)
                    }}
                    className="h-8 w-20 text-sm"
                    placeholder="min"
                    autoFocus
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => {
                      const val = parseInt(customSnoozeMinutes, 10)
                      if (val >= 1 && val <= 1440) {
                        handleDefaultSnoozeChange(String(val))
                        setShowCustomSnooze(false)
                      }
                    }}
                  >
                    Set
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    onClick={() => setShowCustomSnooze(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <select
                  value={
                    ['30', '60', '120', 'tomorrow'].includes(defaultSnoozeOption)
                      ? defaultSnoozeOption
                      : 'custom'
                  }
                  onChange={(e) => {
                    const val = e.target.value
                    if (val === 'custom') {
                      setCustomSnoozeMinutes(
                        defaultSnoozeOption !== 'tomorrow' ? defaultSnoozeOption : '',
                      )
                      setShowCustomSnooze(true)
                    } else {
                      handleDefaultSnoozeChange(val)
                    }
                  }}
                  className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="30">30 min</option>
                  <option value="60">1 hour</option>
                  <option value="120">2 hours</option>
                  <option value="tomorrow">Tomorrow at {formatMorningTime(morningTime)}</option>
                  {!['30', '60', '120', 'tomorrow'].includes(defaultSnoozeOption) && (
                    <option value={defaultSnoozeOption}>
                      {formatSnoozeOptionLabel(defaultSnoozeOption, morningTime)}
                    </option>
                  )}
                  <option value="custom">Custom...</option>
                </select>
              )}
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">Morning time</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Default task time for snooze and AI enrichment
                </div>
              </div>
              <input
                type="time"
                value={morningTime}
                onChange={(e) => {
                  if (e.target.value) handleMorningTimeChange(e.target.value)
                }}
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">Wake time</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  When your day starts (used by AI for time-of-day context)
                </div>
              </div>
              <input
                type="time"
                value={wakeTime}
                onChange={(e) => {
                  if (e.target.value) handleWakeTimeChange(e.target.value)
                }}
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">Sleep time</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  When you go to bed (used by AI for &ldquo;tonight&rdquo; and
                  &ldquo;bedtime&rdquo;)
                </div>
              </div>
              <input
                type="time"
                value={sleepTime}
                onChange={(e) => {
                  if (e.target.value) handleSleepTimeChange(e.target.value)
                }}
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
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

        {/* AI Context */}
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-3 text-sm font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
            AI Context
          </h2>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
            Help the AI understand your situation. This context is included in all AI features
            (enrichment, bubble, review) to improve relevance.
          </p>
          <Textarea
            value={aiContextDraft}
            onChange={(e) => setAiContextDraft(e.target.value)}
            placeholder={
              'e.g., "I work from home as a software engineer. My wife handles groceries. I have two young kids in daycare."'
            }
            maxLength={1000}
            rows={3}
            className="mb-2 text-sm"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">{aiContextDraft.length}/1000</span>
            <Button
              size="sm"
              variant="outline"
              onClick={handleAiContextSave}
              disabled={!aiContextDirty}
              className="h-8"
            >
              Save
            </Button>
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <div>
              <div className="text-sm">Bubble model</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                Model for on-demand Bubble refresh. Opus is slower but more insightful.
              </div>
            </div>
            <select
              value={aiBubbleModel}
              onChange={(e) => handleBubbleModelChange(e.target.value as BubbleModel)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="haiku">Haiku (fast)</option>
              <option value="claude-opus-4-6">Opus (powerful)</option>
            </select>
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
