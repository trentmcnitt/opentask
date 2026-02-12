'use client'

import { createContext, useContext, useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import type { LabelConfig, PriorityDisplayConfig } from '@/types'
import type { AiMode } from '@/hooks/useAiMode'

const DEFAULT_PRIORITY_DISPLAY: PriorityDisplayConfig = {
  trailingDot: true,
  colorTitle: false,
  rightBorder: false,
}

interface PreferencesContextValue {
  labelConfig: LabelConfig[]
  setLabelConfig: (config: LabelConfig[]) => void
  priorityDisplay: PriorityDisplayConfig
  setPriorityDisplay: (config: PriorityDisplayConfig) => void
  autoSnoozeDefault: number
  setAutoSnoozeDefault: (minutes: number) => void
  defaultSnoozeOption: string
  setDefaultSnoozeOption: (option: string) => void
  morningTime: string
  setMorningTime: (time: string) => void
  defaultGrouping: 'time' | 'project'
  setDefaultGrouping: (grouping: 'time' | 'project') => void
  aiContext: string | null
  setAiContext: (context: string | null) => void
  aiMode: AiMode
  setAiMode: (mode: AiMode) => void
  aiShowScores: boolean
  setAiShowScores: (show: boolean) => void
  aiShowSignals: boolean
  setAiShowSignals: (show: boolean) => void
}

const PreferencesContext = createContext<PreferencesContextValue>({
  labelConfig: [],
  setLabelConfig: () => {},
  priorityDisplay: DEFAULT_PRIORITY_DISPLAY,
  setPriorityDisplay: () => {},
  autoSnoozeDefault: 30,
  setAutoSnoozeDefault: () => {},
  defaultSnoozeOption: '60',
  setDefaultSnoozeOption: () => {},
  morningTime: '09:00',
  setMorningTime: () => {},
  defaultGrouping: 'time',
  setDefaultGrouping: () => {},
  aiContext: null,
  setAiContext: () => {},
  aiMode: 'bubble',
  setAiMode: () => {},
  aiShowScores: true,
  setAiShowScores: () => {},
  aiShowSignals: true,
  setAiShowSignals: () => {},
})

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [labelConfig, setLabelConfigState] = useState<LabelConfig[]>([])
  const [priorityDisplay, setPriorityDisplayState] =
    useState<PriorityDisplayConfig>(DEFAULT_PRIORITY_DISPLAY)
  const [autoSnoozeDefault, setAutoSnoozeDefaultState] = useState(30)
  const [defaultSnoozeOption, setDefaultSnoozeOptionState] = useState('60')
  const [morningTime, setMorningTimeState] = useState('09:00')
  const [defaultGrouping, setDefaultGroupingState] = useState<'time' | 'project'>('time')
  const [aiContext, setAiContextState] = useState<string | null>(null)
  const [aiMode, setAiModeState] = useState<AiMode>('bubble')
  const [aiShowScores, setAiShowScoresState] = useState(true)
  const [aiShowSignals, setAiShowSignalsState] = useState(true)

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/user/preferences')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.data?.label_config) {
          setLabelConfigState(data.data.label_config)
        }
        if (data?.data?.priority_display) {
          setPriorityDisplayState(data.data.priority_display)
        }
        if (data?.data?.auto_snooze_minutes) {
          setAutoSnoozeDefaultState(data.data.auto_snooze_minutes)
        }
        if (data?.data?.default_snooze_option) {
          setDefaultSnoozeOptionState(data.data.default_snooze_option)
        }
        if (data?.data?.morning_time) {
          setMorningTimeState(data.data.morning_time)
        }
        if (data?.data?.default_grouping) {
          setDefaultGroupingState(data.data.default_grouping)
        }
        if (data?.data?.ai_context !== undefined) {
          setAiContextState(data.data.ai_context)
        }
        if (data?.data?.ai_mode) {
          setAiModeState(data.data.ai_mode)
        }
        if (data?.data?.ai_show_scores !== undefined) {
          setAiShowScoresState(data.data.ai_show_scores)
        }
        if (data?.data?.ai_show_signals !== undefined) {
          setAiShowSignalsState(data.data.ai_show_signals)
        }
      })
      .catch(() => {})
  }, [status])

  return (
    <PreferencesContext.Provider
      value={{
        labelConfig,
        setLabelConfig: setLabelConfigState,
        priorityDisplay,
        setPriorityDisplay: setPriorityDisplayState,
        autoSnoozeDefault,
        setAutoSnoozeDefault: setAutoSnoozeDefaultState,
        defaultSnoozeOption,
        setDefaultSnoozeOption: setDefaultSnoozeOptionState,
        morningTime,
        setMorningTime: setMorningTimeState,
        defaultGrouping,
        setDefaultGrouping: setDefaultGroupingState,
        aiContext,
        setAiContext: setAiContextState,
        aiMode,
        setAiMode: setAiModeState,
        aiShowScores,
        setAiShowScores: setAiShowScoresState,
        aiShowSignals,
        setAiShowSignals: setAiShowSignalsState,
      }}
    >
      {children}
    </PreferencesContext.Provider>
  )
}

export function useLabelConfig() {
  return useContext(PreferencesContext)
}

export function usePriorityDisplay() {
  const { priorityDisplay, setPriorityDisplay } = useContext(PreferencesContext)
  return { priorityDisplay, setPriorityDisplay }
}

export function useAutoSnoozeDefault() {
  const { autoSnoozeDefault, setAutoSnoozeDefault } = useContext(PreferencesContext)
  return { autoSnoozeDefault, setAutoSnoozeDefault }
}

export function useSnoozePreferences() {
  const { defaultSnoozeOption, setDefaultSnoozeOption, morningTime, setMorningTime } =
    useContext(PreferencesContext)
  return { defaultSnoozeOption, setDefaultSnoozeOption, morningTime, setMorningTime }
}

export function useDefaultGrouping() {
  const { defaultGrouping, setDefaultGrouping } = useContext(PreferencesContext)
  return { defaultGrouping, setDefaultGrouping }
}

export function useAiContext() {
  const { aiContext, setAiContext } = useContext(PreferencesContext)
  return { aiContext, setAiContext }
}

export function useAiPreferences() {
  const { aiMode, setAiMode, aiShowScores, setAiShowScores, aiShowSignals, setAiShowSignals } =
    useContext(PreferencesContext)
  return { aiMode, setAiMode, aiShowScores, setAiShowScores, aiShowSignals, setAiShowSignals }
}
