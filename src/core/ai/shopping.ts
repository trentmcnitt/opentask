/**
 * Shopping list AI label classification
 *
 * Auto-labels shopping list items by store section (produce, dairy, etc.)
 * Integrated into the enrichment pipeline — when a task is in a
 * shopping-type project, store-section labels are added during enrichment.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { aiQuery } from './sdk'
import { extractJsonFromText } from './parse-helpers'
import { SHOPPING_LABEL_SYSTEM_PROMPT } from './prompts'
import { ShoppingLabelResultSchema } from './types'
import { z } from 'zod'

/**
 * Check if a project is a shopping-type project.
 * Uses name-based heuristic: project name contains "shop" or "grocer"
 * (which also matches "grocery", "groceries", etc.).
 */
export function isShoppingProject(projectName: string): boolean {
  const lower = projectName.toLowerCase()
  return lower.includes('shop') || lower.includes('grocer')
}

/**
 * Get store-section labels for shopping items.
 *
 * Called during enrichment when the task is in a shopping project.
 * Returns labels to merge with the task's existing labels.
 */
export async function getShoppingLabels(
  userId: number,
  taskTitle: string,
  projectName: string,
): Promise<string[]> {
  // Guard for direct callers — the enrichment pipeline also pre-checks,
  // but this function may be called independently.
  if (!isShoppingProject(projectName)) return []

  const prompt = `${SHOPPING_LABEL_SYSTEM_PROMPT}

## Item to classify

"${taskTitle}"

Return the store section for this item.`

  const jsonSchema = z.toJSONSchema(ShoppingLabelResultSchema)

  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: process.env.OPENTASK_AI_SHOPPING_MODEL || 'haiku',
    maxTurns: 1,
    userId,
    action: 'shopping_label',
    inputText: taskTitle,
  })

  if (!result.success || (!result.structuredOutput && !result.textResult)) {
    log.error('ai', `Shopping label classification failed for "${taskTitle}"`)
    return []
  }

  let output = result.structuredOutput
  if (!output && result.textResult) {
    output = extractJsonFromText(result.textResult)
  }

  const parsed = ShoppingLabelResultSchema.safeParse(output)
  if (!parsed.success) {
    log.error('ai', 'Invalid shopping label output:', parsed.error.message)
    return []
  }

  return [parsed.data.section]
}

/**
 * Look up the project name for a task by its project_id.
 */
export function getProjectName(projectId: number): string | null {
  const db = getDb()
  const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as
    | { name: string }
    | undefined
  return row?.name ?? null
}
