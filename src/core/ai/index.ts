export { isAIEnabled, initAI, aiQuery } from './sdk'
export type { AIProvider } from './provider'
export {
  isSdkAvailable,
  isSdkAvailableSync,
  isAnthropicAvailable,
  isOpenAIAvailable,
  getServerDefaultProvider,
  resolveModelId,
} from './provider'
export {
  resolveFeatureModel,
  requireFeatureModel,
  resolveFeatureProvider,
  resolveFeatureAIConfig,
  isAnyApiProviderAvailable,
} from './models'
export type {
  AIFeature,
  FeatureProviderConfig,
  FeatureProviderType,
  FeatureAIConfig,
} from './models'
export { processEnrichmentQueue, enrichSingleTask, getEnrichmentPipelineStatus } from './enrichment'
export { logAIActivity, getAIActivity } from './activity'
export { purgeOldAIActivity } from './purge'
export { generateWhatsNext, getCachedWhatsNext } from './whats-next'
export {
  INSIGHTS_SIGNALS,
  SIGNAL_MAP,
  generateInsightsForUser,
  startInsightsGeneration,
  getInsightsSessionStatus,
  getInsightsResults,
  hasInsightsResults,
  getActiveInsightsSession,
  getLastInsightsDurationMs,
} from './insights'
export { buildTaskSummaries } from './task-summaries'
export {
  generateQuickTake,
  buildQuickTakePrompt,
  buildQuickTakeUserPrompt,
  formatCompactTaskList,
  buildTaskStats,
} from './quick-take'
export type { QuickTakeTask, TaskStats } from './quick-take'
export {
  initQuickTakeSlot,
  quickTakeSlotQuery,
  getQuickTakeSlotStats,
  shutdownQuickTakeSlot,
} from './quick-take-slot'
export type { QuickTakeSlotStats } from './quick-take-slot'
export { getUserAiContext, getUserFeatureModes } from './user-context'
export type { FeatureMode } from './user-context'
export { withSlot, getQueueStats } from './queue'
export {
  initEnrichmentSlot,
  enrichmentQuery,
  getEnrichmentSlotStats,
  shutdownEnrichmentSlot,
} from './enrichment-slot'
export type { EnrichmentSlotStats } from './enrichment-slot'
export type {
  EnrichmentResult,
  AIActivityEntry,
  WhatsNextResult,
  TaskSummary,
  InsightsItem,
  InsightsSignalKey,
} from './types'
export type { InsightsSignal, InsightsSession, InsightsResult } from './insights'
export type { SlotState, BaseSlotStats } from './slot-shared'
