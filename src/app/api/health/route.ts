import { NextResponse } from 'next/server'
import { getDb } from '@/core/db'

export function GET() {
  try {
    const db = getDb()
    db.prepare('SELECT 1').get()
    return NextResponse.json({ status: 'ok' })
  } catch {
    return NextResponse.json({ status: 'error', message: 'Database unavailable' }, { status: 503 })
  }
}
