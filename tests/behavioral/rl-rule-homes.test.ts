/**
 * RL-G: THE RULES MAP'S DRIFT GUARD (2026-10-30; src/lib/rule-registry.ts).
 *
 * Every task-state rule has ONE home in the code: a comment block that starts
 * `RULE <ID>:` (a colon right after the id — a pointer, `(restates RULE <ID>,
 * home: <path>)`, never has one). This guard reads the source as text (no
 * database, no app import but the registry) and fails when the code and the
 * registry disagree, in the exact-allowlist style of NF-G02
 * (tm-no-fake-targets.test.ts): each test names what is wrong, so a failure
 * says which block to fix.
 *
 * Changing a rule on purpose: change the code and its block together, and the
 * registry entry (home, symbol, pins) when they moved.
 */

import { describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'
import { RULE_REGISTRY } from '@/lib/rule-registry'

const ROOT = path.resolve(__dirname, '../..')
const REGISTRY_FILE = 'src/lib/rule-registry.ts'
/** How far after its block a home's symbol may sit. */
const SYMBOL_WINDOW = 40
/** How far after the marker the block's Why and Ruling lines must start. */
const FIELD_WINDOW = 12

const HOME_MARKER = /\bRULE ([A-Z][A-Z0-9-]*):/g
const POINTER = /\(restates RULE ([A-Z][A-Z0-9-]*), home: ([^)\s]+)\)/g
/** A cite in the docs: `(RULE X)`, or `RULE X` inside a longer parenthesis. */
const DOC_CITE = /\bRULE ([A-Z][A-Z0-9-]*[A-Z0-9])/g

const registry: Record<string, { home: string; symbol: string; pins: readonly string[] }> =
  RULE_REGISTRY

function sources(): string[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return walk(p)
      return /\.(tsx?|sql)$/.test(e.name) ? [p] : []
    })
  return walk(path.join(ROOT, 'src'))
    .map((p) => path.relative(ROOT, p))
    .filter((rel) => rel !== REGISTRY_FILE)
}

interface Found {
  id: string
  file: string
  /** 0-based line index of the marker. */
  line: number
}

const lines = new Map<string, string[]>()
const homes: Found[] = []
const pointers: { id: string; home: string; file: string; line: number }[] = []
for (const file of sources()) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
  lines.set(file, text)
  text.forEach((l, i) => {
    for (const m of l.matchAll(HOME_MARKER)) homes.push({ id: m[1], file, line: i })
    for (const m of l.matchAll(POINTER)) pointers.push({ id: m[1], home: m[2], file, line: i })
  })
}
const where = (f: Found) => `${f.file}:${f.line + 1}`
const ids = Object.keys(registry)

describe('RL-G: every task-state rule has one commented home (src/lib/rule-registry.ts)', () => {
  test('RL-G01: every registered id has exactly one RULE block', () => {
    const wrong = ids
      .map((id) => ({ id, found: homes.filter((h) => h.id === id) }))
      .filter((x) => x.found.length !== 1)
      .map((x) => `${x.id}: found ${x.found.length} (${x.found.map(where).join(', ')})`)
    expect(wrong).toEqual([])
  })

  test('RL-G02: each block is in its registered home file, which exists', () => {
    const wrong: string[] = []
    for (const id of ids) {
      const { home } = registry[id]
      if (!fs.existsSync(path.join(ROOT, home))) wrong.push(`${id}: no file ${home}`)
      for (const h of homes.filter((x) => x.id === id)) {
        if (h.file !== home) wrong.push(`${id}: block at ${where(h)}, registered home ${home}`)
      }
    }
    expect(wrong).toEqual([])
  })

  test('RL-G03: every RULE block in src/ is registered (no orphans)', () => {
    const orphans = homes.filter((h) => !(h.id in registry)).map((h) => `${h.id} at ${where(h)}`)
    expect(orphans).toEqual([])
  })

  test(`RL-G04: each home's symbol appears within ${SYMBOL_WINDOW} lines after its block`, () => {
    const wrong = homes
      .filter((h) => h.id in registry)
      .filter((h) => {
        const after = lines.get(h.file)!.slice(h.line + 1, h.line + 1 + SYMBOL_WINDOW)
        return !after.join('\n').includes(registry[h.id].symbol)
      })
      .map((h) => `${h.id} at ${where(h)}: no "${registry[h.id].symbol}"`)
    expect(wrong).toEqual([])
  })

  test(`RL-G05: each block has its Why and Ruling lines within ${FIELD_WINDOW} lines`, () => {
    const wrong = homes
      .filter((h) => {
        const next = lines
          .get(h.file)!
          .slice(h.line, h.line + 1 + FIELD_WINDOW)
          .join('\n')
        return !next.includes('Why:') || !next.includes('Ruling:')
      })
      .map(where)
    expect(wrong).toEqual([])
  })

  test('RL-G06: every pointer names a registered id and that id’s home', () => {
    const wrong = pointers
      .filter((p) => !(p.id in registry) || registry[p.id].home !== p.home)
      .map((p) => `${p.file}:${p.line + 1}: ${p.id} → ${p.home}`)
    expect(wrong).toEqual([])
  })

  test('RL-G07: every pin names a file that holds a test or describe titled with its id', () => {
    const wrong: string[] = []
    for (const [id, { pins }] of Object.entries(registry)) {
      for (const pin of pins) {
        const [file, testId] = pin.split('#')
        const abs = path.join(ROOT, file)
        if (!testId || !fs.existsSync(abs)) {
          wrong.push(`${id}: ${pin} (no file)`)
          continue
        }
        const escaped = testId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const title = new RegExp(
          `(?:test|it|describe)(?:\\.\\w+)?\\(\\s*['"\`]${escaped}(?![\\w-])`,
        )
        if (!title.test(fs.readFileSync(abs, 'utf8'))) wrong.push(`${id}: ${pin} (no such title)`)
      }
    }
    expect(wrong).toEqual([])
  })

  test('RL-G08: every RULE X cited in docs/TASK-MODEL.md is registered', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/TASK-MODEL.md'), 'utf8')
    const cited = [...doc.matchAll(DOC_CITE)].map((m) => m[1])
    expect(cited.length).toBeGreaterThan(0)
    expect(cited.filter((id) => !(id in registry))).toEqual([])
  })
})
