/**
 * The dashboard's Projects view orders groups exactly as Settings lists
 * projects: sort_order, then name. Ties used to fall back to whichever
 * project's soonest task came first, so completing that task moved the whole
 * section (Trent, 2026-09-23).
 */
import { describe, expect, test } from 'vitest'
import { buildTaskGroups } from '@/components/TaskList'
import type { Project, Task } from '@/types'

const project = (id: number, name: string, sort_order: number) =>
  ({ id, name, sort_order, owner_id: 1, shared: false, color: null }) as unknown as Project
const task = (id: number, project_id: number, due: string) =>
  ({
    id,
    project_id,
    title: `t${id}`,
    due_at: due,
    done: false,
    priority: 0,
    labels: [],
  }) as unknown as Task

describe('Projects view group order', () => {
  test('ties on sort_order break by name, whatever is due soonest', () => {
    const projects = [project(1, 'Personal', 0), project(2, 'Inbox', 0), project(3, 'Work', 1)]
    // Personal's task is due first, which used to put Personal on top.
    const tasks = [
      task(10, 1, '2026-01-15T15:00:00Z'),
      task(11, 2, '2026-01-16T15:00:00Z'),
      task(12, 3, '2026-01-14T15:00:00Z'),
    ]
    const labels = buildTaskGroups(tasks, projects, 'project', 'America/Chicago', []).map(
      (g) => g.label,
    )
    expect(labels).toEqual(['Inbox', 'Personal', 'Work'])
  })
})
