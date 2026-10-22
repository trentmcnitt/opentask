/**
 * Process — the AI half of the Process button (2026-10-10 task model, spec §5)
 *
 * Process is one button that works the inbox and the backlog. Two of its steps
 * use AI, and both only RECOMMEND — nothing here writes a task:
 *
 * - `recommendProjects` — for tasks the user is sorting, the project each one
 *   probably belongs in (or none). The modal shows every project in a fixed
 *   order with the recommendation highlighted, and the user picks. Topic-based
 *   suggestion is fine HERE, unlike enrichment (Trent's 09-28 "no inference
 *   from topic" ruling), precisely because the user makes the choice. It reads
 *   each project's `description` (what belongs there) and the user's global
 *   `ai_context`.
 * - `findDuplicates` — groups of open one-off tasks that look like the same
 *   piece of work. The user reviews each group.
 *
 * AI off (server-wide, or the user's mode) is not an error: both return
 * `{ status: 'disabled' }` and the routes answer with an empty list, so the
 * Process modal simply has no AI step to show. A failed or unparseable model
 * call is `{ status: 'failed' }` (the routes answer 503).
 *
 * Process is its own AI feature (2026-10-22, Trent): the user's
 * `ai_process_mode` (Settings → AI, the Process row), the `'process'` model
 * config, and the Process default timeout. Until then it rode on the Insights
 * mode, which the AI shelve (src/core/ai/shelved.ts) hid, leaving no way to
 * turn Process on. Process is NOT shelved: nothing under
 * `OPENTASK_AI_UNSHELVE` gates it. Its env vars fall back to the Insights
 * ones when unset (`FEATURE_FALLBACK` in src/core/ai/models.ts), and the
 * column was backfilled from each user's Insights mode, so nobody's Process
 * behaviour changed with the split.
 *
 * Everything the model returns is checked against what it was given: a task id
 * that was not asked about, or a project id that is not one of the user's, is
 * dropped — the model never gets to point the UI at something that isn't there.
 */

import { z } from 'zod'
import { getDb } from '@/core/db'
import { getTasks } from '@/core/tasks'
import { getProjectNameMap } from '@/core/projects'
import { isTracked } from '@/lib/track'
import { log } from '@/lib/logger'
import { aiQuery, isAIEnabled } from './sdk'
import { parseAIResponse, extractJsonFromText } from './parse-helpers'
import { resolveFeatureAIConfig } from './models'
import { getUserAiContext, getUserFeatureModes, resolveFeatureTimeout } from './user-context'

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Most tasks one recommend-projects call takes (one prompt, one model call). */
export const RECOMMEND_PROJECTS_MAX_IDS = 100

const recommendProjectsInput = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1, 'ids must not be empty')
    .max(RECOMMEND_PROJECTS_MAX_IDS, `At most ${RECOMMEND_PROJECTS_MAX_IDS} ids`),
})

export function validateRecommendProjectsInput(input: unknown): { ids: number[] } {
  return recommendProjectsInput.parse(input)
}

// ---------------------------------------------------------------------------
// Output schemas — object roots (a root array kills the CLI subprocess; see
// json-schema.ts and the insights envelope)
// ---------------------------------------------------------------------------

export const ProjectRecommendationsSchema = z.object({
  recommendations: z.array(
    z.object({
      task_id: z.number().int().describe('ID of the task'),
      project_id: z
        .number()
        .int()
        .nullable()
        .describe('ID of the recommended project from the list, or null when none fits'),
      reason: z.string().describe('One short sentence the user reads next to the pick'),
    }),
  ),
})

export const DuplicateGroupsSchema = z.object({
  groups: z.array(
    z.object({
      task_ids: z.array(z.number().int()).describe('2+ task IDs that look like the same work'),
      reason: z.string().describe('One short sentence on why they look like the same work'),
    }),
  ),
})

export type ProjectRecommendation = z.infer<
  typeof ProjectRecommendationsSchema
>['recommendations'][number]
export type DuplicateGroup = z.infer<typeof DuplicateGroupsSchema>['groups'][number]

export type ProcessResult<T> =
  | { status: 'ok'; items: T[] }
  | { status: 'disabled' }
  | { status: 'failed' }

// ---------------------------------------------------------------------------
// Prompts (pure — shared by production, the quality harness and dump-prompts)
// ---------------------------------------------------------------------------

export interface ProcessProject {
  id: number
  name: string
  description: string | null
}

export interface ProcessTask {
  id: number
  title: string
  notes: string | null
  project_name?: string | null
}

/** Notes are context, not content to judge — a short head is enough. */
function notesHead(notes: string | null, max: number): string {
  if (!notes) return ''
  const flat = notes.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export const PROCESS_PROJECTS_INSTRUCTIONS = `You help the user sort tasks into their projects. The user makes every decision: the app shows all their projects with your pick highlighted, and they choose. You only recommend.

For each task, recommend the one project it belongs in, or null.

- Read each project's description first — it says what belongs there. Then its name, then the user context.
- Recommend a project only when the task clearly fits it. When it fits two about equally, or fits none, return null. A wrong pick costs the user more than no pick.
- project_id must be one of the ids in the project list. Never invent an id. The Inbox is not a choice — null means "leave it where it is".
- reason: one short sentence the user reads next to your pick, naming what in the task matches the project (e.g. "Invoice for a client — Client Work holds billing"). For null, say briefly why nothing fits.
- Return exactly one entry per task, in the order given.`

export function buildRecommendProjectsPrompt(params: {
  projects: ProcessProject[]
  tasks: ProcessTask[]
  userContext?: string | null
}): string {
  const projectList = params.projects
    .map((p) => `- [${p.id}] ${p.name} — ${p.description?.trim() || '(no description)'}`)
    .join('\n')
  const taskList = params.tasks
    .map((t) => {
      const notes = notesHead(t.notes, 200)
      return `- [${t.id}] "${t.title}"${notes ? ` | notes: ${notes}` : ''}`
    })
    .join('\n')
  const contextBlock = params.userContext ? `\nUser context: ${params.userContext}\n` : ''

  return `${PROCESS_PROJECTS_INSTRUCTIONS}
${contextBlock}
<projects>
${projectList}
</projects>

<tasks>
${taskList}
</tasks>

Return {"recommendations": [{"task_id", "project_id", "reason"}, ...]} — one entry per task, project_id from the list above or null.`
}

export const PROCESS_DUPLICATES_INSTRUCTIONS = `You find possible duplicates in the user's open tasks: two or more tasks that describe the same piece of work, so doing one would finish the other.

- Same work in different words counts ("Call the dentist" / "Phone dentist about the cleaning").
- Related but different work does NOT count ("Buy paint" / "Paint the fence"; "Call mom" / "Visit mom").
- Similar wording about different things does NOT count ("Email Sam" / "Email Jordan"; "Pay rent" / "Pay the electric bill").
- Be conservative. The user reviews every group, and a false group wastes their time. Finding no duplicates is a normal answer.
- Each group has 2 or more task ids from the list. A task appears in at most one group.
- reason: one short sentence on why they look like the same work.`

export function buildDuplicatesPrompt(params: {
  tasks: ProcessTask[]
  userContext?: string | null
}): string {
  const taskList = params.tasks
    .map((t) => {
      const notes = notesHead(t.notes, 80)
      const project = t.project_name ? ` | project: ${t.project_name}` : ''
      return `- [${t.id}] "${t.title}"${project}${notes ? ` | notes: ${notes}` : ''}`
    })
    .join('\n')
  const contextBlock = params.userContext ? `\nUser context: ${params.userContext}\n` : ''

  return `${PROCESS_DUPLICATES_INSTRUCTIONS}
${contextBlock}
<tasks>
${taskList}
</tasks>

Return {"groups": [{"task_ids": [...], "reason": "..."}]}, or {"groups": []} when nothing looks duplicated.`
}

// ---------------------------------------------------------------------------
// Sanitizers (pure — the model's answer checked against what it was given)
// ---------------------------------------------------------------------------

/**
 * Keep only recommendations for tasks that were asked about (first one per
 * task), with a project the user can use. A hallucinated project id drops the
 * entry — the task then simply has no recommendation, and the modal highlights
 * nothing. Returned in the order the tasks were given.
 */
export function sanitizeRecommendations(
  raw: ProjectRecommendation[],
  taskIds: number[],
  projectIds: Set<number>,
): ProjectRecommendation[] {
  const byTask = new Map<number, ProjectRecommendation>()
  const asked = new Set(taskIds)
  for (const rec of raw) {
    if (!asked.has(rec.task_id) || byTask.has(rec.task_id)) continue
    if (rec.project_id !== null && !projectIds.has(rec.project_id)) {
      log.warn('ai', `Process: dropped recommendation of unknown project ${rec.project_id}`)
      continue
    }
    byTask.set(rec.task_id, {
      task_id: rec.task_id,
      project_id: rec.project_id,
      reason: rec.reason,
    })
  }
  return taskIds.flatMap((id) => (byTask.has(id) ? [byTask.get(id)!] : []))
}

/**
 * Keep only ids that were in the candidate list, each task in at most one group
 * (first group wins), and groups that still have 2+ tasks.
 */
export function sanitizeDuplicateGroups(
  raw: DuplicateGroup[],
  candidateIds: Set<number>,
): DuplicateGroup[] {
  const used = new Set<number>()
  const groups: DuplicateGroup[] = []
  for (const group of raw) {
    const ids = [...new Set(group.task_ids)].filter((id) => candidateIds.has(id) && !used.has(id))
    if (ids.length < 2) continue
    ids.forEach((id) => used.add(id))
    groups.push({ task_ids: ids, reason: group.reason })
  }
  return groups
}

// ---------------------------------------------------------------------------
// Production entry points
// ---------------------------------------------------------------------------

interface ProcessAIConfig {
  run: <T>(params: {
    prompt: string
    schema: z.ZodType<T>
    action: string
    inputText: string
  }) => Promise<T | null>
}

/** The AI for Process, or null when AI is off for this user. */
function processAI(userId: number): ProcessAIConfig | null {
  if (!isAIEnabled()) return null
  const mode = getUserFeatureModes(userId).process
  if (mode === 'off') return null

  return {
    async run({ prompt, schema, action, inputText }) {
      const config = resolveFeatureAIConfig('process', mode)
      const result = await aiQuery({
        prompt,
        outputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
        model: config.model,
        // The CLI spends a turn validating structured output; API mode is one call.
        maxTurns: config.provider === 'sdk' ? 3 : 1,
        userId,
        action,
        inputText,
        timeoutMs: resolveFeatureTimeout(userId, 'process', mode),
        provider: config.provider,
        providerConfig: config.providerConfig,
      })
      return parseAIResponse(result, schema, action, (text) => {
        const json = extractJsonFromText(text)
        if (!json) return null
        const attempt = schema.safeParse(json)
        return attempt.success ? attempt.data : null
      })
    },
  }
}

/**
 * The projects a task can be recommended into: the user's own and the shared
 * ones (the same set enrichment matches against), minus the user's Inbox —
 * "no project" is what null means.
 */
function candidateProjects(userId: number): ProcessProject[] {
  return getDb()
    .prepare(
      `SELECT id, name, description FROM projects
       WHERE (owner_id = ? OR shared = 1) AND NOT (owner_id = ? AND name = 'Inbox')
       ORDER BY sort_order, id`,
    )
    .all(userId, userId) as ProcessProject[]
}

/**
 * Recommend a project for each of the given tasks. Ids that are not the user's
 * own live tasks are ignored. Nothing is written.
 */
export async function recommendProjects(
  userId: number,
  taskIds: number[],
): Promise<ProcessResult<ProjectRecommendation>> {
  const ai = processAI(userId)
  if (!ai) return { status: 'disabled' }

  const unique = [...new Set(taskIds)]
  const placeholders = unique.map(() => '?').join(', ')
  const found = getDb()
    .prepare(
      `SELECT id, title, notes FROM tasks
       WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    )
    .all(userId, ...unique) as ProcessTask[]
  const byId = new Map(found.map((t) => [t.id, t]))
  const tasks = unique.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
  const projects = candidateProjects(userId)
  if (tasks.length === 0 || projects.length === 0) return { status: 'ok', items: [] }

  try {
    const parsed = await ai.run({
      prompt: buildRecommendProjectsPrompt({
        projects,
        tasks,
        userContext: getUserAiContext(userId),
      }),
      schema: ProjectRecommendationsSchema,
      action: 'process_projects',
      inputText: `${tasks.length} tasks`,
    })
    if (!parsed) return { status: 'failed' }
    const items = sanitizeRecommendations(
      parsed.recommendations,
      tasks.map((t) => t.id),
      new Set(projects.map((p) => p.id)),
    )
    return { status: 'ok', items }
  } catch (err) {
    log.warn('ai', 'Process: recommendProjects failed:', err)
    return { status: 'failed' }
  }
}

/** Most open tasks one duplicate scan reads — newest first past this. */
export const DUPLICATES_MAX_TASKS = 600

/**
 * The tasks a duplicate scan looks at: the user's open one-off tasks. Not
 * recurring tasks, reminders or quotas — two of those with the same words are
 * usually two schedules on purpose, and they live on their own surfaces.
 */
function duplicateCandidates(userId: number): ProcessTask[] {
  const tasks = getTasks({ userId, done: false })
    .filter((t) => !t.rrule && !t.is_reminder && !isTracked(t))
    .sort((a, b) => b.id - a.id)
    .slice(0, DUPLICATES_MAX_TASKS)
  const names = getProjectNameMap([...new Set(tasks.map((t) => t.project_id))])
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    notes: t.notes,
    project_name: names.get(t.project_id) ?? null,
  }))
}

/** Possible duplicates among the user's open one-off tasks. Nothing is written. */
export async function findDuplicates(userId: number): Promise<ProcessResult<DuplicateGroup>> {
  const ai = processAI(userId)
  if (!ai) return { status: 'disabled' }

  const tasks = duplicateCandidates(userId)
  if (tasks.length < 2) return { status: 'ok', items: [] }

  try {
    const parsed = await ai.run({
      prompt: buildDuplicatesPrompt({ tasks, userContext: getUserAiContext(userId) }),
      schema: DuplicateGroupsSchema,
      action: 'process_duplicates',
      inputText: `${tasks.length} tasks`,
    })
    if (!parsed) return { status: 'failed' }
    return {
      status: 'ok',
      items: sanitizeDuplicateGroups(parsed.groups, new Set(tasks.map((t) => t.id))),
    }
  } catch (err) {
    log.warn('ai', 'Process: findDuplicates failed:', err)
    return { status: 'failed' }
  }
}
