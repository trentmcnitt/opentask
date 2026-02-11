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

  // Run migrations for columns that may not exist in older databases
  runMigrations(database)
}

function runMigrations(database: Database.Database): void {
  // Helper to check if a column exists
  const hasColumn = (table: string, column: string): boolean => {
    const columns = database.pragma(`table_info(${table})`) as { name: string }[]
    return columns.some((c) => c.name === column)
  }

  // Migration: Add last_notified_at to tasks
  if (!hasColumn('tasks', 'last_notified_at')) {
    database.exec('ALTER TABLE tasks ADD COLUMN last_notified_at TEXT')
  }

  // Migration: Add ntfy settings to users
  if (!hasColumn('users', 'ntfy_topic')) {
    database.exec('ALTER TABLE users ADD COLUMN ntfy_topic TEXT')
  }
  if (!hasColumn('users', 'ntfy_server')) {
    database.exec('ALTER TABLE users ADD COLUMN ntfy_server TEXT')
  }

  // Migration: Add default_grouping to users
  if (!hasColumn('users', 'default_grouping')) {
    database.exec("ALTER TABLE users ADD COLUMN default_grouping TEXT NOT NULL DEFAULT 'project'")
  }

  // Migration: Add label_config to users
  if (!hasColumn('users', 'label_config')) {
    database.exec("ALTER TABLE users ADD COLUMN label_config TEXT NOT NULL DEFAULT '[]'")
  }

  // Migration: Add priority_display to users
  if (!hasColumn('users', 'priority_display')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN priority_display TEXT NOT NULL DEFAULT \'{"trailingDot":true,"colorTitle":false,"rightBorder":false}\'',
    )
  }

  // Migration: Add per-task stats columns
  if (!hasColumn('tasks', 'completion_count')) {
    database.exec('ALTER TABLE tasks ADD COLUMN completion_count INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn('tasks', 'snooze_count')) {
    database.exec('ALTER TABLE tasks ADD COLUMN snooze_count INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn('tasks', 'first_completed_at')) {
    database.exec('ALTER TABLE tasks ADD COLUMN first_completed_at TEXT')
  }
  if (!hasColumn('tasks', 'last_completed_at')) {
    database.exec('ALTER TABLE tasks ADD COLUMN last_completed_at TEXT')
  }
  // Migration: Unify notes — merge meta_notes column and notes table into tasks.notes
  if (hasColumn('tasks', 'meta_notes') && !hasColumn('tasks', 'notes')) {
    // Step 1: Add the new notes column and copy meta_notes values
    database.exec('ALTER TABLE tasks ADD COLUMN notes TEXT')
    database.exec('UPDATE tasks SET notes = meta_notes WHERE meta_notes IS NOT NULL')

    // Step 2: Merge any rows from the separate notes table into tasks.notes
    const hasNotesTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'")
      .get()
    if (hasNotesTable) {
      // For each task that has entries in the notes table, concatenate them
      // (ordered by created_at) and append to any existing notes value
      const tasksWithNotes = database
        .prepare(
          `SELECT task_id, GROUP_CONCAT(content, char(10) || char(10)) as merged
           FROM (SELECT task_id, content FROM notes ORDER BY created_at ASC)
           GROUP BY task_id`,
        )
        .all() as { task_id: number; merged: string }[]

      const updateStmt = database.prepare(
        `UPDATE tasks SET notes = CASE
           WHEN notes IS NOT NULL AND notes != '' THEN notes || char(10) || char(10) || ?
           ELSE ?
         END
         WHERE id = ?`,
      )
      for (const row of tasksWithNotes) {
        updateStmt.run(row.merged, row.merged, row.task_id)
      }

      // Step 3: Drop the notes table and its index
      database.exec('DROP INDEX IF EXISTS idx_notes_task_id')
      database.exec('DROP TABLE IF EXISTS notes')
    }

    // Step 4: Drop the old meta_notes column
    database.exec('ALTER TABLE tasks DROP COLUMN meta_notes')
  } else if (!hasColumn('tasks', 'notes') && !hasColumn('tasks', 'meta_notes')) {
    // Fresh DB that predates both columns
    database.exec('ALTER TABLE tasks ADD COLUMN notes TEXT')
  }

  // Clean up: drop notes table if it still exists (for DBs that already have tasks.notes)
  {
    const hasNotesTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'")
      .get()
    if (hasNotesTable) {
      database.exec('DROP INDEX IF EXISTS idx_notes_task_id')
      database.exec('DROP TABLE IF EXISTS notes')
    }
  }

  // Migration: Add auto_snooze_minutes to users
  if (!hasColumn('users', 'auto_snooze_minutes')) {
    database.exec('ALTER TABLE users ADD COLUMN auto_snooze_minutes INTEGER NOT NULL DEFAULT 30')
  }

  // Migration: Add auto_snooze_minutes to tasks
  if (!hasColumn('tasks', 'auto_snooze_minutes')) {
    database.exec('ALTER TABLE tasks ADD COLUMN auto_snooze_minutes INTEGER')
  }

  // Migration: Add default_snooze_option to users
  if (!hasColumn('users', 'default_snooze_option')) {
    database.exec("ALTER TABLE users ADD COLUMN default_snooze_option TEXT NOT NULL DEFAULT '60'")
  }

  // Migration: Add morning_time to users
  if (!hasColumn('users', 'morning_time')) {
    database.exec("ALTER TABLE users ADD COLUMN morning_time TEXT NOT NULL DEFAULT '09:00'")
  }

  // Migration: Rename snoozed_from to original_due_at
  if (hasColumn('tasks', 'snoozed_from') && !hasColumn('tasks', 'original_due_at')) {
    database.exec('ALTER TABLE tasks RENAME COLUMN snoozed_from TO original_due_at')
  }

  // Migration: Add original_title to tasks
  if (!hasColumn('tasks', 'original_title')) {
    database.exec('ALTER TABLE tasks ADD COLUMN original_title TEXT')
  }

  // Migration: Drop ai_status column (replaced by label-based enrichment)
  // Drop index first — if the column was dropped but the index wasn't, the index is corrupted
  database.exec('DROP INDEX IF EXISTS idx_tasks_ai_status')
  if (hasColumn('tasks', 'ai_status')) {
    database.exec('ALTER TABLE tasks DROP COLUMN ai_status')
  }

  // Migration: Create user_daily_stats table if it doesn't exist
  // This is handled by schema.sql CREATE TABLE IF NOT EXISTS, but we need
  // to ensure the table exists for older databases that ran schema.sql
  // before this table was added
  const hasStatsTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_daily_stats'")
    .get()
  if (!hasStatsTable) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS user_daily_stats (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id),
        date          TEXT NOT NULL,
        completions   INTEGER NOT NULL DEFAULT 0,
        tasks_created INTEGER NOT NULL DEFAULT 0,
        snoozes       INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_user_daily_stats_user_date
        ON user_daily_stats(user_id, date);
    `)
  }
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
