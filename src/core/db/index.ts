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
