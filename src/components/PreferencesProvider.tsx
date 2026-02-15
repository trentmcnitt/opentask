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

export type WhatsNextModel = 'haiku' | 'claude-opus-4-6'

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
  defaultGrouping: 'time' | 'project' | 'unified'
  setDefaultGrouping: (grouping: 'time' | 'project' | 'unified') => void
  aiContext: string | null
  setAiContext: (context: string | null) => void
  aiMode: AiMode
  setAiMode: (mode: AiMode) => void
  aiShowScores: boolean
  setAiShowScores: (show: boolean) => void
  aiShowSignals: boolean
  setAiShowSignals: (show: boolean) => void
  aiShowWhatsNext: boolean
  setAiShowWhatsNext: (show: boolean) => void
  aiShowInsights: boolean
  setAiShowInsights: (show: boolean) => void
  aiShowCommentary: boolean
  setAiShowCommentary: (show: boolean) => void
  aiWhatsNextModel: WhatsNextModel
  setAiWhatsNextModel: (model: WhatsNextModel) => void
  aiWnCommentaryUnfiltered: boolean
  setAiWnCommentaryUnfiltered: (show: boolean) => void
  aiWnHighlight: boolean
  setAiWnHighlight: (show: boolean) => void
  aiInsightsSignalChips: boolean
  setAiInsightsSignalChips: (show: boolean) => void
  aiInsightsScoreChips: boolean
  setAiInsightsScoreChips: (show: boolean) => void
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
  aiShowWhatsNext: true,
  setAiShowWhatsNext: () => {},
  aiShowInsights: true,
  setAiShowInsights: () => {},
  aiShowCommentary: true,
  setAiShowCommentary: () => {},
  aiWhatsNextModel: 'haiku',
  setAiWhatsNextModel: () => {},
  aiWnCommentaryUnfiltered: false,
  setAiWnCommentaryUnfiltered: () => {},
  aiWnHighlight: true,
  setAiWnHighlight: () => {},
  aiInsightsSignalChips: true,
  setAiInsightsSignalChips: () => {},
  aiInsightsScoreChips: true,
  setAiInsightsScoreChips: () => {},
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
  const [defaultGrouping, setDefaultGroupingState] = useState<'time' | 'project' | 'unified'>(
    'project',
  )
  const [aiContext, setAiContextState] = useState<string | null>(null)
  const [aiMode, setAiModeState] = useState<AiMode>('on')
  const [aiShowScores, setAiShowScoresState] = useState(true)
  const [aiShowSignals, setAiShowSignalsState] = useState(true)
  const [aiShowWhatsNext, setAiShowWhatsNextState] = useState(true)
  const [aiShowInsights, setAiShowInsightsState] = useState(true)
  const [aiShowCommentary, setAiShowCommentaryState] = useState(true)
  const [aiWhatsNextModel, setAiWhatsNextModelState] = useState<WhatsNextModel>('haiku')
  const [aiWnCommentaryUnfiltered, setAiWnCommentaryUnfilteredState] = useState(false)
  const [aiWnHighlight, setAiWnHighlightState] = useState(true)
  const [aiInsightsSignalChips, setAiInsightsSignalChipsState] = useState(true)
  const [aiInsightsScoreChips, setAiInsightsScoreChipsState] = useState(true)

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
        if (data?.data?.ai_show_whats_next !== undefined) {
          setAiShowWhatsNextState(data.data.ai_show_whats_next)
        }
        if (data?.data?.ai_show_insights !== undefined) {
          setAiShowInsightsState(data.data.ai_show_insights)
        }
        if (data?.data?.ai_show_commentary !== undefined) {
          setAiShowCommentaryState(data.data.ai_show_commentary)
        }
        if (data?.data?.ai_whats_next_model) {
          const model = data.data.ai_whats_next_model
          if (model === 'haiku' || model === 'claude-opus-4-6') {
            setAiWhatsNextModelState(model)
          }
        }
        if (data?.data?.ai_wn_commentary_unfiltered !== undefined) {
          setAiWnCommentaryUnfilteredState(data.data.ai_wn_commentary_unfiltered)
        }
        if (data?.data?.ai_wn_highlight !== undefined) {
          setAiWnHighlightState(data.data.ai_wn_highlight)
        }
        if (data?.data?.ai_insights_signal_chips !== undefined) {
          setAiInsightsSignalChipsState(data.data.ai_insights_signal_chips)
        }
        if (data?.data?.ai_insights_score_chips !== undefined) {
          setAiInsightsScoreChipsState(data.data.ai_insights_score_chips)
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
        setDefaultGrouping: (grouping: 'time' | 'project' | 'unified') => {
          setDefaultGroupingState(grouping)
          fetch('/api/user/preferences', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_grouping: grouping }),
          }).catch(() => {})
        },
        aiContext,
        setAiContext: setAiContextState,
        aiMode,
        setAiMode: setAiModeState,
        aiShowScores,
        setAiShowScores: setAiShowScoresState,
        aiShowSignals,
        setAiShowSignals: setAiShowSignalsState,
        aiShowWhatsNext,
        setAiShowWhatsNext: setAiShowWhatsNextState,
        aiShowInsights,
        setAiShowInsights: setAiShowInsightsState,
        aiShowCommentary,
        setAiShowCommentary: setAiShowCommentaryState,
        aiWhatsNextModel,
        setAiWhatsNextModel: setAiWhatsNextModelState,
        aiWnCommentaryUnfiltered,
        setAiWnCommentaryUnfiltered: setAiWnCommentaryUnfilteredState,
        aiWnHighlight,
        setAiWnHighlight: setAiWnHighlightState,
        aiInsightsSignalChips,
        setAiInsightsSignalChips: setAiInsightsSignalChipsState,
        aiInsightsScoreChips,
        setAiInsightsScoreChips: setAiInsightsScoreChipsState,
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
    aiShowWhatsNext,
    setAiShowWhatsNext,
    aiShowInsights,
    setAiShowInsights,
    aiShowCommentary,
    setAiShowCommentary,
    aiWhatsNextModel,
    setAiWhatsNextModel,
    aiWnCommentaryUnfiltered,
    setAiWnCommentaryUnfiltered,
    aiWnHighlight,
    setAiWnHighlight,
    aiInsightsSignalChips,
    setAiInsightsSignalChips,
    aiInsightsScoreChips,
    setAiInsightsScoreChips,
  } = useContext(PreferencesContext)
  return {
    aiMode,
    setAiMode,
    aiShowScores,
    setAiShowScores,
    aiShowSignals,
    setAiShowSignals,
    aiShowWhatsNext,
    setAiShowWhatsNext,
    aiShowInsights,
    setAiShowInsights,
    aiShowCommentary,
    setAiShowCommentary,
    aiWhatsNextModel,
    setAiWhatsNextModel,
    aiWnCommentaryUnfiltered,
    setAiWnCommentaryUnfiltered,
    aiWnHighlight,
    setAiWnHighlight,
    aiInsightsSignalChips,
    setAiInsightsSignalChips,
    aiInsightsScoreChips,
    setAiInsightsScoreChips,
  }
}
