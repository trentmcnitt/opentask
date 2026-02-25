export { isAIEnabled, initAI, aiQuery } from './sdk'
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
  formatCompactTaskList,
  buildTaskStats,
} from './quick-take'
export type { QuickTakeTask, TaskStats } from './quick-take'
export { getUserAiContext, getUserWhatsNextModel } from './user-context'
export { withSlot, getQueueStats } from './queue'
export {
  initEnrichmentSlot,
  enrichmentQuery,
  getEnrichmentSlotStats,
  shutdownEnrichmentSlot,
} from './enrichment-slot'
export type {
  EnrichmentResult,
  AIActivityEntry,
  WhatsNextResult,
  TaskSummary,
  InsightsItem,
  InsightsSignalKey,
} from './types'
export type { InsightsSignal, InsightsSession, InsightsResult } from './insights'
