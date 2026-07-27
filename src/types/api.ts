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

/**
 * Route context for dynamic routes keyed by name rather than ID.
 * Used in /api/labels/[name] — labels are identified by their canonical name,
 * which is what callers actually have (§7.2).
 */
export interface NameRouteContext {
  params: Promise<{ name: string }>
}
