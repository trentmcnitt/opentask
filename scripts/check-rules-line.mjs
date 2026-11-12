#!/usr/bin/env node
/**
 * THE PR BODY'S "Rules:" LINE (2026-11-12, the rules map's drift check).
 *
 * The drift guard (tests/behavioral/rl-rule-homes.test.ts) catches a RULE
 * block that moves, loses its symbol or is not registered. It cannot catch a
 * behaviour change that writes no block at all — which is how the map fell 24
 * rules behind in ten days. So every pull request says, in its description:
 *
 *   Rules: DECK-A1, TQ-PRECEDENCE     the rule blocks this PR added or changed
 *   Rules: none                       it changes no task-state rule
 *
 * This script reads the body from the PR_BODY environment variable and fails
 * when the line is missing, or names an id that is not in
 * src/lib/rule-registry.ts. Run by .github/workflows/rules-line.yml.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The ids named on the body's Rules line: [] for "none", null when there is no line. */
export function rulesLine(body) {
  const match = /^[ \t>*_-]*Rules:[*_ \t]*(.+)$/im.exec(body ?? '')
  if (!match) return null
  const value = match[1].replace(/[`*_.]/g, ' ').trim()
  if (/^none\b/i.test(value)) return []
  return value.split(/[\s,;]+/).filter(Boolean)
}

/** Every id in the registry (its keys, read as text: no build step in CI's check). */
export function registeredIds(root = ROOT) {
  const text = fs.readFileSync(path.join(root, 'src/lib/rule-registry.ts'), 'utf8')
  return new Set([...text.matchAll(/^ {2}'?([A-Z][A-Z0-9-]*)'?: \{$/gm)].map((m) => m[1]))
}

/** The problem with a body's Rules line, or null when it is fine. */
export function rulesLineProblem(body, ids = registeredIds()) {
  const named = rulesLine(body)
  if (named === null) {
    return 'The description has no "Rules:" line. Add "Rules: <ids>" (the RULE blocks this PR added or changed) or "Rules: none".'
  }
  const unknown = named.filter((id) => !ids.has(id))
  if (unknown.length > 0) {
    return `Rules: names ${unknown.join(', ')}, not in src/lib/rule-registry.ts. Register the block, or fix the id.`
  }
  return null
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problem = rulesLineProblem(process.env.PR_BODY ?? '')
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
  console.log('Rules line OK')
}
