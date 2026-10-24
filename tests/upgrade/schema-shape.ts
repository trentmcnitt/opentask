/**
 * The upgrade test's schema comparison (2026-10-24): what a database looks
 * like, table by table, and what an upgraded one lacks that a fresh one has.
 *
 * Compared: every table; every column's name, declared type, NOT NULL and
 * DEFAULT; every index's table, columns, uniqueness and partial WHERE clause.
 * An upgraded database may have MORE (a legacy column nothing reads, an
 * old index) — only what it lacks or declares differently counts. Column
 * ORDER is not compared: an appended column is the normal shape of an
 * upgrade. CHECK constraints are not compared: SQLite cannot add one to an
 * existing table, so an upgraded table never has the CHECKs a later
 * CREATE TABLE gained.
 *
 * Indexes SQLite makes for a UNIQUE or PRIMARY KEY constraint
 * (`sqlite_autoindex_<table>_<n>`) are matched by what they cover, not by
 * name: the number depends on the table's history.
 */

import type Database from 'better-sqlite3'

export interface ColumnShape {
  type: string
  notnull: number
  dflt: string | null
}

export interface IndexShape {
  table: string
  columns: string[]
  unique: number
  /** The WHERE clause of a partial index, whitespace- and case-normalized; '' if none. */
  where: string
  auto: boolean
}

export interface SchemaShape {
  tables: Record<string, Record<string, ColumnShape>>
  indexes: Record<string, IndexShape>
}

function whereOf(sql: string | null): string {
  if (!sql) return ''
  const m = sql.match(/\bWHERE\b([\s\S]*)$/i)
  return m ? m[1].replace(/\s+/g, ' ').trim().toLowerCase() : ''
}

export function describeSchema(db: Database.Database): SchemaShape {
  const shape: SchemaShape = { tables: {}, indexes: {} }
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as { name: string }[]
  const sqlOf = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
  for (const { name: table } of tables) {
    const cols = db.pragma(`table_info(${table})`) as {
      name: string
      type: string
      notnull: number
      dflt_value: string | null
    }[]
    shape.tables[table] = Object.fromEntries(
      cols.map((c) => [
        c.name,
        // `DEFAULT NULL` and no DEFAULT are the same column.
        {
          type: c.type.toUpperCase(),
          notnull: c.notnull,
          dflt: c.dflt_value === 'NULL' ? null : c.dflt_value,
        },
      ]),
    )
    const indexes = db.pragma(`index_list(${table})`) as {
      name: string
      unique: number
      origin: string
    }[]
    for (const ix of indexes) {
      const columns = (db.pragma(`index_info("${ix.name}")`) as { name: string | null }[]).map(
        (c) => c.name ?? '<expr>',
      )
      const auto = ix.name.startsWith('sqlite_autoindex_')
      const sql = (sqlOf.get(ix.name) as { sql: string | null } | undefined)?.sql ?? null
      const key = auto ? `auto:${table}(${columns.join(',')})` : ix.name
      shape.indexes[key] = { table, columns, unique: ix.unique, where: whereOf(sql), auto }
    }
  }
  return shape
}

/**
 * What `upgraded` lacks or declares differently from `fresh`, one line each.
 * `allowedDrift` holds known, accepted legacy DEFAULTs by `table.column`: the
 * one old default it may keep (any other difference on that column still
 * counts), each with its reason at the call site.
 */
export function schemaGaps(
  fresh: SchemaShape,
  upgraded: SchemaShape,
  allowedDrift: Record<string, { legacyDefault: string | null; why: string }> = {},
): string[] {
  const gaps: string[] = []
  for (const [table, cols] of Object.entries(fresh.tables)) {
    const have = upgraded.tables[table]
    if (!have) {
      gaps.push(`missing table ${table}`)
      continue
    }
    for (const [col, want] of Object.entries(cols)) {
      const got = have[col]
      if (!got) {
        gaps.push(`missing column ${table}.${col}`)
        continue
      }
      const allowed = allowedDrift[`${table}.${col}`]
      for (const k of ['type', 'notnull', 'dflt'] as const) {
        if (k === 'dflt' && allowed && got.dflt === allowed.legacyDefault) continue
        if (got[k] !== want[k]) {
          gaps.push(
            `${table}.${col}: ${k} is ${String(got[k])}, a fresh database has ${String(want[k])}`,
          )
        }
      }
    }
  }
  for (const [name, want] of Object.entries(fresh.indexes)) {
    const got = upgraded.indexes[name]
    if (!got) {
      gaps.push(`missing index ${name} on ${want.table}(${want.columns.join(', ')})`)
      continue
    }
    const a = JSON.stringify([got.table, got.columns, got.unique, got.where])
    const b = JSON.stringify([want.table, want.columns, want.unique, want.where])
    if (a !== b) gaps.push(`index ${name} is ${a}, a fresh database has ${b}`)
  }
  return gaps
}
