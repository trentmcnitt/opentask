/**
 * Format a project database row for API response.
 * Converts SQLite integer `shared` (0/1) to boolean.
 */

import type { Project } from '@/types'

export interface ProjectRow {
  id: number
  name: string
  owner_id: number
  shared: number
  sort_order: number
  active_count: number
  overdue_count: number
  created_at: string
}

export function formatProjectResponse(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    owner_id: row.owner_id,
    shared: row.shared === 1,
    sort_order: row.sort_order,
    active_count: row.active_count,
    overdue_count: row.overdue_count,
    created_at: row.created_at,
  }
}
