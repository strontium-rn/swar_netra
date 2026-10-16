// Server storage: a single JSON file (server/data/store.json).
//
// A real database (Postgres, SQLite...) is the usual choice, but we have a few dozen
// households with a few phones each: a file is enough, and easy to look inside.
// Upgrade path: when it grows, only this file needs to change.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

const DIR = process.env.DATA_DIR ?? join(import.meta.dirname, 'data')
const FILE = join(DIR, 'store.json')

export async function loadStore(): Promise<Store> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as Store
  } catch {
    // First start: make our VAPID keys (once; they must never change, or every phone
    // would have to pair again).
    const store: Store = { vapid: webpush.generateVAPIDKeys(), households: {} }
    await saveStore(store)
    return store
  }
}

// Write to a temporary file, then rename it over the real one. A rename is "atomic": it
// either fully happens or not at all, so a crash mid-write can never leave a half-written,
// broken file behind.
export async function saveStore(store: Store): Promise<void> {
  await mkdir(DIR, { recursive: true })
  await writeFile(`${FILE}.tmp`, JSON.stringify(store, null, 1))
  await rename(`${FILE}.tmp`, FILE)
}
