/**
 * The dashboard's All view (`'project'`) groups by project, and orders the
 * groups exactly as Settings lists projects: sort_order, then name. Ties used
 * to fall back to whichever project's soonest task came first, so completing
 * that task moved the whole section (2026-09-23).
 */
import { describe, expect, test } from 'vitest'
import { buildTaskGroups } from '@/lib/task-grouping'
import type { Project, Task } from '@/types'

const project = (id: number, name: string, sort_order: number, color: string | null = null) =>
  ({ id, name, sort_order, owner_id: 1, shared: false, color }) as unknown as Project
const task = (id: number, project_id: number, due: string | null) =>
  ({
    id,
    project_id,
    title: `t${id}`,
    due_at: due,
    done: false,
    priority: 0,
    labels: [],
  }) as unknown as Task

describe('All view: project groups', () => {
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

  test('every task lands in its project, overdue and undated alike; empty projects get no group', () => {
    const projects = [project(1, 'Inbox', 0, 'blue'), project(2, 'Work', 1), project(3, 'Empty', 2)]
    const tasks = [
      task(1, 1, '2020-01-01T00:00:00Z'), // long overdue
      task(2, 1, null),
      task(3, 2, '2099-01-01T00:00:00Z'),
    ]
    const groups = buildTaskGroups(tasks, projects, 'project', 'America/Chicago', [])
    expect(groups.map((g) => [g.label, g.tasks.map((t) => t.id).sort()])).toEqual([
      ['Inbox', [1, 2]],
      ['Work', [3]],
    ])
    // The heading's color tag comes from the project.
    expect(groups.map((g) => g.color)).toEqual(['blue', null])
  })

  test('a task whose project is not in the list still gets a group', () => {
    const groups = buildTaskGroups([task(1, 9, null)], [], 'project', 'America/Chicago', [])
    expect(groups.map((g) => g.label)).toEqual(['Project 9'])
  })
})
