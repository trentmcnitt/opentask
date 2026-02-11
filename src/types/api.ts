/**
 * Shared API route types
 */

/**
 * Route context for dynamic routes with an ID parameter
 * Used in /api/tasks/[id]/* and /api/projects/[id] routes
 */
export interface RouteContext {
  params: Promise<{ id: string }>
}
