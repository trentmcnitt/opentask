'use client'

import { useState } from 'react'
import { Info, Loader2, Check, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAiContext, useAiPreferences, useAiFeatureInfo } from '@/components/PreferencesProvider'
import type { FeatureMode, FeatureInfo, FeatureInfoMap } from '@/components/PreferencesProvider'
import { savePreference } from '@/lib/save-preference'
import { showToast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { SettingsSection } from './SettingsSection'

type FeatureKey = 'enrichment' | 'quicktake' | 'whats_next' | 'insights'

const FEATURE_FIELD: Record<FeatureKey, string> = {
  enrichment: 'ai_enrichment_mode',
  quicktake: 'ai_quicktake_mode',
  whats_next: 'ai_whats_next_mode',
  insights: 'ai_insights_mode',
}

const showDemoToast = () => {
  showToast({ message: 'This setting is not available in demo mode', type: 'error' })
}

/**
 * Settings → AI Context: the free-text context every AI feature sees, and each
 * feature's Off / SDK / API mode. The page renders this only when AI is
 * enabled server-side. Demo users see it read-only.
 */
export function AiSection({ isDemo }: { isDemo: boolean }) {
  return (
    <SettingsSection
      title="AI Context"
      description={
        <>
          Help the AI understand your situation. This context is included in all AI features
          (enrichment, what&apos;s next, insights) to improve relevance.
        </>
      }
    >
      <AiContextEditor isDemo={isDemo} />
      <FeatureModes isDemo={isDemo} />
      {isDemo && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          AI settings are view-only in demo mode.
        </p>
      )}
    </SettingsSection>
  )
}

/**
 * The AI context textarea and its Save button. `draft` is null until the user
 * types, and the field shows the saved context until then — so it fills in
 * when the preferences load, without an effect copying the value across.
 */
function AiContextEditor({ isDemo }: { isDemo: boolean }) {
  const { aiContext, setAiContext } = useAiContext()
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? aiContext ?? ''
  const dirty = value !== (aiContext ?? '')

  const handleSave = async () => {
    if (isDemo) {
      showDemoToast()
      return
    }
    const newValue = value.trim() || null
    const prev = aiContext
    await savePreference(
      { ai_context: newValue },
      {
        apply: () => setAiContext(newValue),
        revert: () => setAiContext(prev),
        successMessage: 'AI context saved',
        errorMessage: 'Failed to save AI context',
      },
    )
  }

  return (
    <>
      <Textarea
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={
          'e.g., "I work from home as a software engineer. My wife handles groceries. I have two young kids in daycare."'
        }
        maxLength={1000}
        rows={3}
        className="mb-2 text-sm"
        disabled={isDemo}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-400">{value.length}/1000</span>
        <Button
          size="sm"
          variant="outline"
          onClick={handleSave}
          disabled={!dirty || isDemo}
          className="h-8"
        >
          Save
        </Button>
      </div>
    </>
  )
}

/** Per-feature AI mode selectors (Off / SDK / API). */
function FeatureModes({ isDemo }: { isDemo: boolean }) {
  const {
    aiEnrichmentMode,
    setAiEnrichmentMode,
    aiQuickTakeMode,
    setAiQuickTakeMode,
    aiWhatsNextMode,
    setAiWhatsNextMode,
    aiInsightsMode,
    setAiInsightsMode,
    aiSdkAvailable,
    aiApiAvailable,
  } = useAiPreferences()
  const { aiFeatureInfo, setAiFeatureInfo } = useAiFeatureInfo()

  const handleFeatureModeChange = async (
    feature: FeatureKey,
    value: FeatureMode,
    setter: (mode: FeatureMode) => void,
    prev: FeatureMode,
  ) => {
    if (isDemo) {
      showDemoToast()
      return
    }
    // The response carries each feature's info recomputed for its new mode
    // (`getFeatureInfo` in the preferences route).
    const data = await savePreference<{ ai_feature_info?: FeatureInfoMap }>(
      { [FEATURE_FIELD[feature]]: value },
      { apply: () => setter(value), revert: () => setter(prev) },
    )
    if (data?.ai_feature_info) setAiFeatureInfo(data.ai_feature_info)
  }

  const features = [
    {
      label: 'Enrichment',
      desc: 'Parses new tasks into structured fields',
      mode: aiEnrichmentMode,
      setter: setAiEnrichmentMode,
      key: 'enrichment' as const,
      infoKey: 'enrichment',
    },
    {
      label: 'Quick Take',
      desc: 'One-line AI observation when you add a task',
      mode: aiQuickTakeMode,
      setter: setAiQuickTakeMode,
      key: 'quicktake' as const,
      infoKey: 'quick_take',
    },
    {
      label: "What's Next",
      desc: 'Recommends which tasks to work on',
      mode: aiWhatsNextMode,
      setter: setAiWhatsNextMode,
      key: 'whats_next' as const,
      infoKey: 'whats_next',
    },
    {
      label: 'Insights',
      desc: 'Scores tasks by review urgency',
      mode: aiInsightsMode,
      setter: setAiInsightsMode,
      key: 'insights' as const,
      infoKey: 'insights',
    },
  ] as const

  return (
    <div className="mt-4 space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <div className="mb-2">
        <div className="text-sm font-medium">Feature modes</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          Off disables the feature. SDK uses Claude Code subprocesses. API makes direct HTTP calls.
        </div>
      </div>
      {features.map((feature) => (
        <FeatureModeRow
          key={feature.key}
          label={feature.label}
          desc={feature.desc}
          mode={feature.mode}
          infoKey={feature.infoKey}
          info={aiFeatureInfo?.[feature.infoKey] ?? null}
          sdkAvailable={aiSdkAvailable}
          apiAvailable={aiApiAvailable}
          disabled={isDemo}
          onModeChange={(value) =>
            handleFeatureModeChange(feature.key, value, feature.setter, feature.mode)
          }
        />
      ))}
    </div>
  )
}

// --- FeatureModeRow: Per-feature mode selector with info popover and test button ---

function FeatureModeRow({
  label,
  desc,
  mode,
  infoKey,
  info,
  sdkAvailable,
  apiAvailable,
  disabled,
  onModeChange,
}: {
  label: string
  desc: string
  mode: FeatureMode
  infoKey: string
  info: FeatureInfo | null
  sdkAvailable: boolean
  apiAvailable: boolean
  disabled?: boolean
  onModeChange: (value: FeatureMode) => void
}) {
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testResult, setTestResult] = useState<string | null>(null)

  const handleTest = async () => {
    setTestState('testing')
    setTestResult(null)
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: infoKey }),
      })
      const json = await res.json()
      if (res.ok && json?.data?.success) {
        setTestState('success')
        setTestResult(`OK — ${(json.data.duration_ms / 1000).toFixed(1)}s`)
      } else {
        setTestState('error')
        setTestResult(json?.data?.error || json?.error || 'Test failed')
      }
    } catch {
      setTestState('error')
      setTestResult('Network error')
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm">{label}</span>
          <Popover
            onOpenChange={(open) => {
              if (!open) {
                setTestState('idle')
                setTestResult(null)
              }
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label={`${label} info`}
              >
                <Info className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-64 p-3 text-xs">
              <FeatureInfoPopover
                info={info}
                mode={mode}
                testState={testState}
                testResult={testResult}
                onTest={handleTest}
              />
            </PopoverContent>
          </Popover>
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{desc}</div>
      </div>
      <div
        className={cn(
          'flex rounded-md border border-zinc-200 dark:border-zinc-700',
          disabled && 'opacity-50',
        )}
      >
        {(['off', 'sdk', 'api'] as const).map((opt) => {
          const unavailable = (opt === 'sdk' && !sdkAvailable) || (opt === 'api' && !apiAvailable)
          const active = mode === opt
          return (
            <button
              key={opt}
              onClick={() => onModeChange(opt)}
              disabled={disabled}
              className={cn(
                'px-3 py-1 text-xs font-medium transition-colors first:rounded-l-md last:rounded-r-md',
                active && unavailable
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : active
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : unavailable
                      ? 'text-zinc-300 hover:text-zinc-400 dark:text-zinc-600 dark:hover:text-zinc-500'
                      : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
              )}
            >
              {opt === 'off' ? 'Off' : opt.toUpperCase()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FeatureInfoPopover({
  info,
  mode,
  testState,
  testResult,
  onTest,
}: {
  info: FeatureInfo | null
  mode: FeatureMode
  testState: 'idle' | 'testing' | 'success' | 'error'
  testResult: string | null
  onTest: () => void
}) {
  if (mode === 'off') {
    return <p className="text-muted-foreground">Feature is disabled.</p>
  }

  if (info && !info.available) {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 flex-shrink-0" />
          <span>
            {mode === 'sdk'
              ? 'SDK mode selected but Claude Code is not installed on this server.'
              : 'API mode selected but no API key configured.'}
          </span>
        </div>
        <FeatureInfoRow label="Provider" value="Not available" />
        <FeatureInfoRow label="Model" value="Not configured" />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <FeatureInfoRow label="Provider" value={info?.provider_display ?? '—'} />
      <FeatureInfoRow label="Model" value={info?.model_display ?? '—'} />
      <div className="border-t border-zinc-200 pt-2 dark:border-zinc-700">
        {testState === 'idle' && (
          <Button size="sm" variant="outline" className="h-6 text-xs" onClick={onTest}>
            Test
          </Button>
        )}
        {testState === 'testing' && (
          <span className="text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="size-3 animate-spin" /> Testing...
          </span>
        )}
        {testState === 'success' && (
          <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
            <Check className="size-3" /> {testResult}
          </span>
        )}
        {testState === 'error' && (
          <span className="text-red-600 dark:text-red-400">{testResult}</span>
        )}
      </div>
    </div>
  )
}

function FeatureInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-medium">{value}</span>
    </div>
  )
}
