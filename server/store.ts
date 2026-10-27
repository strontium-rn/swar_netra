// Server storage. Two places it can live, chosen when the server starts:
//
//   DATABASE_URL set   → a Postgres database (online, e.g. Neon). Hosting services like
//                        Render wipe the server's own disk on every restart and deploy, so
//                        anything we want to keep must live in a database.
//   not set            → JSON files in server/data/ (on your own laptop: easy to look inside).
//
// What we keep:
//   1. The "store": our VAPID keys + households and their phones. Small (a few KB), so it is
//      saved as ONE JSON document, whole, every time it changes. Simple, and plenty for a
//      prototype; a real product would give households and phones their own tables.
//   2. Study records: calibration results and feedback forms from testers who agreed.
//      One row per record, so they can be listed and exported.

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import webpush from 'web-push'

export type Phone = {
  secretHash: string
  subscription: webpush.PushSubscription // the phone's push "address" at Google
  name: string // sealed: only the laptop can read it (e.g. "Mum")
  addedAt: number
}

export type Household = {
  laptopHash: string
  joinHash: string
  phones: Record<string, Phone>
  createdAt: number
}

export type Store = {
  // VAPID keys: our server's own signature for push messages. Google only delivers push
  // signed with the key the phone subscribed with, so nobody else can push to our phones.
  vapid: { publicKey: string; privateKey: string }
  households: Record<string, Household>
}

export type StudyRecord = {
  participant: string // random ID made in the tester's browser: no name, no email
  kind: 'consent' | 'calibration' | 'feedback'
  data: unknown
  at: string // when the server received it (ISO date)
}

// ---- Postgres ----

const db = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 }) : null

// Create the tables the first time (IF NOT EXISTS: safe to run on every start).
async function setUpDatabase(pool: pg.Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (id TEXT PRIMARY KEY, value JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS study_records (
      id BIGSERIAL PRIMARY KEY,
      participant TEXT NOT NULL,
      kind TEXT NOT NULL,
      data JSONB NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS study_records_participant ON study_records (participant);
  `)
}

// ---- Files (laptop) ----

const DIR = process.env.DATA_DIR ?? join(import.meta.dirname, 'data')
const FILE = join(DIR, 'store.json')
const STUDY_FILE = join(DIR, 'study.jsonl') // one JSON record per line

// ---- The store ----

export const storageName = db ? 'Postgres database' : `files in ${DIR}`

export async function loadStore(): Promise<Store> {
  let saved: Store | null = null
  if (db) {
    await setUpDatabase(db)
    saved = (await db.query('SELECT value FROM app_state WHERE id = $1', ['store'])).rows[0]?.value ?? null
  } else {
    saved = await readFile(FILE, 'utf8').then((text) => JSON.parse(text) as Store, () => null)
  }
  if (saved) return saved
  // First start: make our VAPID keys (once; they must never change, or every phone
  // would have to pair again).
  const store: Store = { vapid: webpush.generateVAPIDKeys(), households: {} }
  await saveStore(store)
  return store
}

export async function saveStore(store: Store): Promise<void> {
  if (db) {
    // "Upsert": insert the row, or replace it if it already exists.
    await db.query('INSERT INTO app_state (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = $2', ['store', JSON.stringify(store)])
    return
  }
  // Write to a temporary file, then rename it over the real one. A rename is "atomic": it
  // either fully happens or not at all, so a crash mid-write can never leave a half-written,
  // broken file behind.
  await mkdir(DIR, { recursive: true })
  await writeFile(`${FILE}.tmp`, JSON.stringify(store, null, 1))
  await rename(`${FILE}.tmp`, FILE)
}

// ---- Study records ----
// Queries use $1, $2… placeholders, never text glued into the SQL: the database treats the
// values strictly as data, so a tester can't sneak SQL commands in ("SQL injection").

export async function addStudyRecord(record: Omit<StudyRecord, 'at'>): Promise<void> {
  if (db) {
    await db.query('INSERT INTO study_records (participant, kind, data) VALUES ($1, $2, $3)', [record.participant, record.kind, JSON.stringify(record.data)])
    return
  }
  await mkdir(DIR, { recursive: true })
  await appendFile(STUDY_FILE, JSON.stringify({ ...record, at: new Date().toISOString() }) + '\n')
}

export async function allStudyRecords(): Promise<StudyRecord[]> {
  if (db) {
    const { rows } = await db.query('SELECT participant, kind, data, at FROM study_records ORDER BY id')
    return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }))
  }
  const text = await readFile(STUDY_FILE, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as StudyRecord)
}

// A tester left the study: delete everything they sent. Returns how many records went.
export async function deleteParticipant(participant: string): Promise<number> {
  if (db) return (await db.query('DELETE FROM study_records WHERE participant = $1', [participant])).rowCount ?? 0
  const all = await allStudyRecords()
  const kept = all.filter((r) => r.participant !== participant)
  await mkdir(DIR, { recursive: true })
  await writeFile(`${STUDY_FILE}.tmp`, kept.map((r) => JSON.stringify(r) + '\n').join(''))
  await rename(`${STUDY_FILE}.tmp`, STUDY_FILE)
  return all.length - kept.length
}
