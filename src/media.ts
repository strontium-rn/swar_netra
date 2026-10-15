// Media store: the caregiver's photos and voice recordings.
//
// They're too big for localStorage (text only, ~5 MB in total), so they go in IndexedDB:
// the browser's built-in database for this website. It stores real files ("Blobs"), holds
// hundreds of MB, and like localStorage it never leaves this computer.
//
// The vocabulary only keeps an id for each file (e.g. word.audio = "a1b2…"). Keeping the big
// files apart from the small word list means saving a label change never rewrites a photo.

const DB_NAME = 'swar-netra-media'
const STORE = 'media'

// IndexedDB's API is older than Promises (it uses callbacks); this turns one request into
// a Promise, so the rest of the code can simply `await` it.
function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

let db: Promise<IDBDatabase> | null = null
function open(): Promise<IDBDatabase> {
  if (!db) {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE) // first run: create the table
    db = done(request)
  }
  return db
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await open()).transaction(STORE, mode).objectStore(STORE)
}

// Ready-to-show web addresses for every saved file, by id. The board needs them
// immediately while drawing, so we load them all up front (there are only a few dozen).
const urls = new Map<string, string>()

export function mediaUrl(id: string | undefined): string | undefined {
  return id ? urls.get(id) : undefined
}

// Save a file; returns its new id.
export async function addMedia(blob: Blob): Promise<string> {
  const id = crypto.randomUUID()
  await done((await store('readwrite')).put(blob, id))
  urls.set(id, URL.createObjectURL(blob))
  return id
}

// Load all saved files, and delete the ones no longer used (e.g. a replaced photo).
export async function loadMedia(keep: Set<string>): Promise<void> {
  try {
    const ids = (await done((await store('readonly')).getAllKeys())) as string[]
    const unused = ids.filter((id) => !keep.has(id))
    if (unused.length) {
      const s = await store('readwrite')
      for (const id of unused) {
        s.delete(id)
        const url = urls.get(id)
        if (url) URL.revokeObjectURL(url) // free the memory behind the address
        urls.delete(id)
      }
    }
    for (const id of ids) {
      if (!keep.has(id) || urls.has(id)) continue
      const blob = await getMedia(id)
      if (blob) urls.set(id, URL.createObjectURL(blob))
    }
  } catch {
    // Storage blocked (e.g. private browsing): photos and recordings just won't show.
  }
}

export async function getMedia(id: string): Promise<Blob | undefined> {
  return (await done((await store('readonly')).get(id))) as Blob | undefined
}
