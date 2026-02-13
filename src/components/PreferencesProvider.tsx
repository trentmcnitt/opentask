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

export type BubbleModel = 'haiku' | 'claude-opus-4-6'

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
  wakeTime: string
  setWakeTime: (time: string) => void
  sleepTime: string
  setSleepTime: (time: string) => void
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
  aiShowBubbleText: boolean
  setAiShowBubbleText: (show: boolean) => void
  aiShowCommentary: boolean
  setAiShowCommentary: (show: boolean) => void
  aiBubbleModel: BubbleModel
  setAiBubbleModel: (model: BubbleModel) => void
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
  wakeTime: '07:00',
  setWakeTime: () => {},
  sleepTime: '22:00',
  setSleepTime: () => {},
  defaultGrouping: 'time',
  setDefaultGrouping: () => {},
  aiContext: null,
  setAiContext: () => {},
  aiMode: 'on',
  setAiMode: () => {},
  aiShowScores: true,
  setAiShowScores: () => {},
  aiShowSignals: true,
  setAiShowSignals: () => {},
  aiShowBubbleText: true,
  setAiShowBubbleText: () => {},
  aiShowCommentary: true,
  setAiShowCommentary: () => {},
  aiBubbleModel: 'haiku',
  setAiBubbleModel: () => {},
})

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [labelConfig, setLabelConfigState] = useState<LabelConfig[]>([])
  const [priorityDisplay, setPriorityDisplayState] =
    useState<PriorityDisplayConfig>(DEFAULT_PRIORITY_DISPLAY)
  const [autoSnoozeDefault, setAutoSnoozeDefaultState] = useState(30)
  const [defaultSnoozeOption, setDefaultSnoozeOptionState] = useState('60')
  const [morningTime, setMorningTimeState] = useState('09:00')
  const [wakeTime, setWakeTimeState] = useState('07:00')
  const [sleepTime, setSleepTimeState] = useState('22:00')
  const [defaultGrouping, setDefaultGroupingState] = useState<'time' | 'project'>('time')
  const [aiContext, setAiContextState] = useState<string | null>(null)
  const [aiMode, setAiModeState] = useState<AiMode>('on')
  const [aiShowScores, setAiShowScoresState] = useState(true)
  const [aiShowSignals, setAiShowSignalsState] = useState(true)
  const [aiShowBubbleText, setAiShowBubbleTextState] = useState(true)
  const [aiShowCommentary, setAiShowCommentaryState] = useState(true)
  const [aiBubbleModel, setAiBubbleModelState] = useState<BubbleModel>('haiku')

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
        if (data?.data?.wake_time) {
          setWakeTimeState(data.data.wake_time)
        }
        if (data?.data?.sleep_time) {
          setSleepTimeState(data.data.sleep_time)
        }
        if (data?.data?.default_grouping) {
          setDefaultGroupingState(data.data.default_grouping)
        }
        if (data?.data?.ai_context !== undefined) {
          setAiContextState(data.data.ai_context)
        }
        if (data?.data?.ai_mode) {
          // Defensive mapping: accept valid modes, default to 'on'
          const mode = data.data.ai_mode
          if (mode === 'off' || mode === 'on') {
            setAiModeState(mode)
          } else {
            setAiModeState('on')
          }
        }
        if (data?.data?.ai_show_scores !== undefined) {
          setAiShowScoresState(data.data.ai_show_scores)
        }
        if (data?.data?.ai_show_signals !== undefined) {
          setAiShowSignalsState(data.data.ai_show_signals)
        }
        if (data?.data?.ai_show_bubble_text !== undefined) {
          setAiShowBubbleTextState(data.data.ai_show_bubble_text)
        }
        if (data?.data?.ai_show_commentary !== undefined) {
          setAiShowCommentaryState(data.data.ai_show_commentary)
        }
        if (data?.data?.ai_bubble_model) {
          const model = data.data.ai_bubble_model
          if (model === 'haiku' || model === 'claude-opus-4-6') {
            setAiBubbleModelState(model)
          }
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
        wakeTime,
        setWakeTime: setWakeTimeState,
        sleepTime,
        setSleepTime: setSleepTimeState,
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
        aiShowBubbleText,
        setAiShowBubbleText: setAiShowBubbleTextState,
        aiShowCommentary,
        setAiShowCommentary: setAiShowCommentaryState,
        aiBubbleModel,
        setAiBubbleModel: setAiBubbleModelState,
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

export function useSchedulePreferences() {
  const { wakeTime, setWakeTime, sleepTime, setSleepTime } = useContext(PreferencesContext)
  return { wakeTime, setWakeTime, sleepTime, setSleepTime }
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
  const {
    aiMode,
    setAiMode,
    aiShowScores,
    setAiShowScores,
    aiShowSignals,
    setAiShowSignals,
    aiShowBubbleText,
    setAiShowBubbleText,
    aiShowCommentary,
    setAiShowCommentary,
    aiBubbleModel,
    setAiBubbleModel,
  } = useContext(PreferencesContext)
  return {
    aiMode,
    setAiMode,
    aiShowScores,
    setAiShowScores,
    aiShowSignals,
    setAiShowSignals,
    aiShowBubbleText,
    setAiShowBubbleText,
    aiShowCommentary,
    setAiShowCommentary,
    aiBubbleModel,
    setAiBubbleModel,
  }
}
