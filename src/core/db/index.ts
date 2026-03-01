import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

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
