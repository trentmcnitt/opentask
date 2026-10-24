/**
 * DI-S01: schema.sql never indexes a column that runMigrations adds.
 *
 * getDb() runs schema.sql BEFORE runMigrations(). On a fresh database every
 * column is in the CREATE TABLE, so an index on it works. On an EXISTING
 * database the CREATE TABLE IF NOT EXISTS is skipped: a column that only
 * runMigrations' ALTER TABLE adds does not exist yet, so a CREATE INDEX on it
 * in schema.sql fails with "no such column" and the migration never runs.
 * Every test database is built fresh, so nothing else catches it — it took
 * prod down for one deploy on 2026-10-24 (`idx_tasks_target_slot`, rolled
 * back in seconds). Such an index belongs in runMigrations, after its ALTER.
 */

import { describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = process.cwd()
const schema = fs.readFileSync(path.join(root, 'src/core/db/schema.sql'), 'utf8')
const migrations = fs.readFileSync(path.join(root, 'src/core/db/index.ts'), 'utf8')

/** `table.column` for every column an ALTER TABLE … ADD COLUMN adds in runMigrations. */
function addedColumns(): Set<string> {
  const added = new Set<string>()
  for (const m of migrations.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/g)) {
    added.add(`${m[1]}.${m[2]}`)
  }
  return added
}

/** Each CREATE INDEX in schema.sql (comments stripped): its table and the columns it names. */
function schemaIndexes(): { name: string; table: string; columns: string[] }[] {
  const sql = schema.replace(/--[^\n]*/g, '')
  const out: { name: string; table: string; columns: string[] }[] = []
  const re =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)([^;]*);/gi
  for (const m of sql.matchAll(re)) {
    const words = `${m[3]} ${m[4]}`.match(/[A-Za-z_]\w*/g) ?? []
    out.push({ name: m[1], table: m[2], columns: words })
  }
  return out
}

describe('DI-S01: schema.sql never indexes a column runMigrations adds', () => {
  test('the scan finds the migrations and the indexes', () => {
    expect(addedColumns().size).toBeGreaterThan(10)
    expect(schemaIndexes().length).toBeGreaterThan(10)
  })

  test('no index in schema.sql names a migration-added column of its table', () => {
    const added = addedColumns()
    const offenders = schemaIndexes().flatMap((ix) =>
      ix.columns
        .filter((c) => added.has(`${ix.table}.${c}`))
        .map((c) => `${ix.name} on ${ix.table}.${c}`),
    )
    expect(offenders).toEqual([])
  })
})
