/**
 * The quiet line shown after an Insights run that scored only some tasks — in
 * the Insights section of the AI panel and under the "Insights updated" toast.
 * A muted note, not an error: the run finished and its scores are in. Returns
 * null when every task was scored.
 */
export function unscoredTasksText(count: number): string | null {
  if (count <= 0) return null
  return `${count} ${count === 1 ? 'task' : 'tasks'} couldn't be scored`
}
