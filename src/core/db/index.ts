import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { SYSTEM_LABELS } from '@/lib/label-vocabulary'

const DB_PATH = process.env.OPENTASK_DB_PATH || path.join(process.cwd(), 'data', 'tasks.db')

// Singleton database instance
let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) {
    return db
  }

  // Ensure the data directory exists
  const dataDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  // Create database connection with WAL mode for better concurrent performance
  db = new Database(DB_PATH)

  // Enable WAL mode and set pragmas for performance and safety
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000') // 5 second timeout for locks
  db.pragma('synchronous = NORMAL') // Balance between safety and performance
  db.pragma('foreign_keys = ON') // Enforce foreign key constraints

  // Initialize schema
  initSchema(db)

  return db
}

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  const cols = database.pragma(`table_info(${table})`) as { name: string }[]
  return cols.some((c) => c.name === column)
}

/**
 * Run migrations for existing databases that need new columns.
 * Each migration uses hasColumn() to be idempotent.
 */
function runMigrations(database: Database.Database): void {
  // AI UX refactor: new preference columns (2026-02)
  if (!hasColumn(database, 'users', 'ai_wn_commentary_unfiltered')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN ai_wn_commentary_unfiltered INTEGER NOT NULL DEFAULT 0',
    )
    // Preserve existing behavior: users who had WN annotations on should see them without filtering
    database.exec('UPDATE users SET ai_wn_commentary_unfiltered = 1 WHERE ai_show_whats_next = 1')
  }
  if (!hasColumn(database, 'users', 'ai_wn_highlight')) {
    database.exec('ALTER TABLE users ADD COLUMN ai_wn_highlight INTEGER NOT NULL DEFAULT 1')
  }
  if (!hasColumn(database, 'users', 'ai_insights_signal_chips')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN ai_insights_signal_chips INTEGER NOT NULL DEFAULT 1',
    )
  }
  if (!hasColumn(database, 'users', 'ai_insights_score_chips')) {
    database.exec('ALTER TABLE users ADD COLUMN ai_insights_score_chips INTEGER NOT NULL DEFAULT 1')
  }
  // Quick Take user toggle (2026-02) — default OFF for alpha
  if (!hasColumn(database, 'users', 'ai_quick_take')) {
    database.exec('ALTER TABLE users ADD COLUMN ai_quick_take INTEGER NOT NULL DEFAULT 0')
  }
  // Priority-based notification intervals (2026-02)
  if (!hasColumn(database, 'users', 'auto_snooze_urgent_minutes')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN auto_snooze_urgent_minutes INTEGER NOT NULL DEFAULT 5',
    )
  }
  if (!hasColumn(database, 'users', 'auto_snooze_high_minutes')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN auto_snooze_high_minutes INTEGER NOT NULL DEFAULT 15',
    )
  }
  // Independent cooldown for critical alerts (2026-02)
  if (!hasColumn(database, 'tasks', 'last_critical_alert_at')) {
    database.exec('ALTER TABLE tasks ADD COLUMN last_critical_alert_at TEXT')
  }
  // Per-user notification toggle (2026-02)
  if (!hasColumn(database, 'users', 'notifications_enabled')) {
    database.exec('ALTER TABLE users ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1')
  }
  // Project colors (2026-02)
  if (!hasColumn(database, 'projects', 'color')) {
    database.exec('ALTER TABLE projects ADD COLUMN color TEXT')
  }
  // Critical alert volume (2026-02)
  if (!hasColumn(database, 'users', 'critical_alert_volume')) {
    database.exec('ALTER TABLE users ADD COLUMN critical_alert_volume REAL NOT NULL DEFAULT 1.0')
  }
  // AI provider selection (2026-03)
  if (!hasColumn(database, 'users', 'ai_provider')) {
    database.exec("ALTER TABLE users ADD COLUMN ai_provider TEXT NOT NULL DEFAULT 'default'")
  }
  if (!hasColumn(database, 'ai_activity_log', 'provider')) {
    database.exec('ALTER TABLE ai_activity_log ADD COLUMN provider TEXT')
  }
  // Rename 'api' → 'anthropic' in ai_provider (2026-03)
  const apiCount = (
    database.prepare("SELECT COUNT(*) as c FROM users WHERE ai_provider = 'api'").get() as {
      c: number
    }
  ).c
  if (apiCount > 0) {
    database.exec("UPDATE users SET ai_provider = 'anthropic' WHERE ai_provider = 'api'")
  }
  // Per-feature AI backend modes (2026-03)
  if (!hasColumn(database, 'users', 'ai_enrichment_mode')) {
    database.exec("ALTER TABLE users ADD COLUMN ai_enrichment_mode TEXT NOT NULL DEFAULT 'api'")
    database.exec("ALTER TABLE users ADD COLUMN ai_quicktake_mode TEXT NOT NULL DEFAULT 'api'")
    database.exec("ALTER TABLE users ADD COLUMN ai_whats_next_mode TEXT NOT NULL DEFAULT 'api'")
    database.exec("ALTER TABLE users ADD COLUMN ai_insights_mode TEXT NOT NULL DEFAULT 'api'")
    // Migrate from old ai_provider column: sdk → sdk, anthropic/openai/default → api
    database.exec(
      `UPDATE users SET
        ai_enrichment_mode = CASE WHEN ai_provider = 'sdk' THEN 'sdk' ELSE 'api' END,
        ai_quicktake_mode = CASE WHEN ai_provider = 'sdk' THEN 'sdk' ELSE 'api' END,
        ai_whats_next_mode = CASE WHEN ai_provider = 'sdk' THEN 'sdk' ELSE 'api' END,
        ai_insights_mode = CASE WHEN ai_provider = 'sdk' THEN 'sdk' ELSE 'api' END`,
    )
    // Migrate visibility toggles: show=0 → mode='off'
    database.exec("UPDATE users SET ai_whats_next_mode = 'off' WHERE ai_show_whats_next = 0")
    database.exec("UPDATE users SET ai_insights_mode = 'off' WHERE ai_show_insights = 0")
    database.exec("UPDATE users SET ai_quicktake_mode = 'off' WHERE ai_show_commentary = 0")
  }
  // Per-user AI query timeout (2026-03) — vestigial, kept for existing DBs
  if (!hasColumn(database, 'users', 'ai_query_timeout_ms')) {
    database.exec('ALTER TABLE users ADD COLUMN ai_query_timeout_ms INTEGER')
  }
  // Per-feature per-user AI query timeouts (2026-03)
  if (!hasColumn(database, 'users', 'ai_enrichment_timeout_ms')) {
    database.exec('ALTER TABLE users ADD COLUMN ai_enrichment_timeout_ms INTEGER')
    database.exec('ALTER TABLE users ADD COLUMN ai_quicktake_timeout_ms INTEGER')
    database.exec('ALTER TABLE users ADD COLUMN ai_whats_next_timeout_ms INTEGER')
    database.exec('ALTER TABLE users ADD COLUMN ai_insights_timeout_ms INTEGER')
    // Migrate: copy old global timeout to the two features that respected it.
    // Quick Take (hardcoded 40s) and Insights (hardcoded 15min) were never affected.
    database.exec(`UPDATE users SET
      ai_enrichment_timeout_ms = ai_query_timeout_ms,
      ai_whats_next_timeout_ms = ai_query_timeout_ms
      WHERE ai_query_timeout_ms IS NOT NULL`)
  }
  // Demo user flag (2026-03)
  if (!hasColumn(database, 'users', 'is_demo')) {
    database.exec('ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0')
  }
  // Auto-set flag for existing demo users (idempotent)
  database.exec("UPDATE users SET is_demo = 1 WHERE LOWER(name) = 'demo' AND is_demo = 0")

  // Sort order persistence (2026-03)
  if (!hasColumn(database, 'users', 'default_sort')) {
    database.exec("ALTER TABLE users ADD COLUMN default_sort TEXT NOT NULL DEFAULT 'due_date'")
  }
  if (!hasColumn(database, 'users', 'default_sort_reversed')) {
    database.exec('ALTER TABLE users ADD COLUMN default_sort_reversed INTEGER NOT NULL DEFAULT 0')
  }

  // iOS auto-provisioned token source tracking (2026-03)
  if (!hasColumn(database, 'api_tokens', 'source')) {
    database.exec("ALTER TABLE api_tokens ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
  }

  // Token hashing: add token_preview column and hash existing plaintext tokens (2026-02)
  if (!hasColumn(database, 'api_tokens', 'token_preview')) {
    database.exec('ALTER TABLE api_tokens ADD COLUMN token_preview TEXT')
    // Migrate existing plaintext tokens to SHA-256 hashes
    const tokens = database.prepare('SELECT id, token FROM api_tokens').all() as {
      id: number
      token: string
    }[]
    const update = database.prepare(
      'UPDATE api_tokens SET token = ?, token_preview = ? WHERE id = ?',
    )
    for (const row of tokens) {
      // Only hash if it looks like a plaintext token (64 hex chars from randomBytes(32))
      // SHA-256 hashes are also 64 hex chars, so we use a heuristic: if token_preview
      // is already set, it was already migrated. Since we just added the column, all
      // rows have NULL token_preview, so all will be migrated.
      const preview = row.token.slice(-8)
      const hashed = createHash('sha256').update(row.token).digest('hex')
      update.run(hashed, preview, row.id)
    }
  }

  // Track / quotas + skip (REDESIGN-V03 §5, §7.5)
  if (!hasColumn(database, 'tasks', 'progress_target')) {
    database.exec('ALTER TABLE tasks ADD COLUMN progress_target INTEGER NOT NULL DEFAULT 1')
  }
  if (!hasColumn(database, 'tasks', 'progress_current')) {
    database.exec('ALTER TABLE tasks ADD COLUMN progress_current INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(database, 'tasks', 'skip_count')) {
    database.exec('ALTER TABLE tasks ADD COLUMN skip_count INTEGER NOT NULL DEFAULT 0')
  }
  // Reminders surface (§6)
  if (!hasColumn(database, 'tasks', 'is_reminder')) {
    database.exec('ALTER TABLE tasks ADD COLUMN is_reminder INTEGER NOT NULL DEFAULT 0')
  }

  backfillLabelRegistry(database)
  backfillTimeSlots(database)
}

/**
 * Give every existing user the default time slots (REDESIGN-V03 §6.0).
 *
 * `seedDefaultTimeSlots` runs at user creation, but users who existed before
 * this shipped would otherwise have none — and a user with no slots gets a
 * dashboard where every item falls into the un-slotted group, which looks
 * broken rather than empty.
 *
 * Only touches users who have zero slots, so customised boundaries are never
 * clobbered.
 */
function backfillTimeSlots(database: Database.Database): void {
  // Kept in sync with DEFAULT_TIME_SLOTS in src/core/time-slots. Duplicated
  // rather than imported because that module imports getDb from here, and a
  // cycle at module-init time is exactly where it would break.
  const defaults: [string, string][] = [
    ['Early morning', '07:00'],
    ['Before work', '09:00'],
    ['Midday', '12:00'],
    ['Afternoon', '16:00'],
    ['Evening', '20:30'],
  ]

  const insert = database.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )

  const run = database.transaction(() => {
    const users = database
      .prepare(
        `SELECT u.id FROM users u
          WHERE NOT EXISTS (SELECT 1 FROM time_slots s WHERE s.user_id = u.id)`,
      )
      .all() as { id: number }[]

    for (const user of users) {
      defaults.forEach(([label, startTime], index) => {
        insert.run(user.id, label, startTime, index)
      })
    }
  })

  run()
}

/**
 * Seed the label registry from labels already in use (REDESIGN-V03 §7.2).
 *
 * Enforcement rejects unknown labels, so the registry MUST be populated before
 * validation turns on — otherwise every existing task fails the moment anyone
 * edits it. This runs on startup, ahead of any request.
 *
 * Sources both `tasks.labels` (the labels actually on tasks) and each user's
 * `label_config` (labels they styled but may have since removed from every
 * task) so nothing already known to the app is treated as a typo.
 *
 * Idempotent: INSERT OR IGNORE against the unique (user_id, name) index, so
 * re-running adds only genuinely new values. Labels created after this point
 * come through the API's explicit create path, not from here.
 */
function backfillLabelRegistry(database: Database.Database): void {
  const insert = database.prepare(
    'INSERT OR IGNORE INTO labels (user_id, name, facet) VALUES (?, ?, ?)',
  )

  // Operational labels carry behavior rather than domain meaning. Recording the
  // facet here keeps the chip bar's AND-across-facets grouping correct without
  // a second pass to classify them later.
  const OPERATIONAL = SYSTEM_LABELS

  const backfill = database.transaction(() => {
    // Seed the operational labels for every user regardless of current use.
    // These are system vocabulary, not user taxonomy: `ai-added` in particular
    // must already exist or the first `confirm` on a task would be rejected as
    // an unknown label by the very validation this registry adds.
    const allUsers = database.prepare('SELECT id FROM users').all() as { id: number }[]
    for (const user of allUsers) {
      for (const name of OPERATIONAL) {
        insert.run(user.id, name, 'operational')
      }
    }

    const taskRows = database.prepare('SELECT user_id, labels FROM tasks').all() as {
      user_id: number
      labels: string
    }[]
    for (const row of taskRows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.labels || '[]')
      } catch {
        continue
      }
      if (!Array.isArray(parsed)) continue
      for (const name of parsed) {
        if (typeof name !== 'string' || name.length === 0) continue
        insert.run(row.user_id, name, OPERATIONAL.has(name) ? 'operational' : 'domain')
      }
    }

    const userRows = database.prepare('SELECT id, label_config FROM users').all() as {
      id: number
      label_config: string
    }[]
    for (const row of userRows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.label_config || '[]')
      } catch {
        continue
      }
      if (!Array.isArray(parsed)) continue
      for (const entry of parsed) {
        const name = (entry as { name?: unknown })?.name
        if (typeof name !== 'string' || name.length === 0) continue
        insert.run(row.id, name, OPERATIONAL.has(name) ? 'operational' : 'domain')
      }
    }
  })

  backfill()
}

function initSchema(database: Database.Database): void {
  const schemaPath = path.join(__dirname, 'schema.sql')

  // In development/testing, the schema.sql might be in a different location
  let schema: string
  if (fs.existsSync(schemaPath)) {
    schema = fs.readFileSync(schemaPath, 'utf-8')
  } else {
    // Fallback: look relative to cwd for Next.js builds
    const altPath = path.join(process.cwd(), 'src', 'core', 'db', 'schema.sql')
    if (fs.existsSync(altPath)) {
      schema = fs.readFileSync(altPath, 'utf-8')
    } else {
      throw new Error(`Schema file not found at ${schemaPath} or ${altPath}`)
    }
  }

  // Execute schema (CREATE IF NOT EXISTS is idempotent)
  database.exec(schema)

  // Run migrations for existing databases
  runMigrations(database)
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

// For testing: reset database to fresh state
export function resetDb(): void {
  closeDb()
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH)
    // Also remove WAL and SHM files if they exist
    const walPath = `${DB_PATH}-wal`
    const shmPath = `${DB_PATH}-shm`
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath)
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath)
  }
}

// Utility to run a function inside a transaction
export function withTransaction<T>(fn: (db: Database.Database) => T): T {
  const database = getDb()
  return database.transaction(fn)(database)
}
