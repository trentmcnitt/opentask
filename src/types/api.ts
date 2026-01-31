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
 * Route context for nested dynamic routes with ID + NID parameters
 * Used in /api/tasks/[id]/notes/[nid] routes
 */
export interface NoteRouteContext {
  params: Promise<{ id: string; nid: string }>
}
