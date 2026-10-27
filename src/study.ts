// User study: testers who agree send their calibration results and a feedback form to
// the researcher. Nothing is sent before the tester says yes on the consent screen.
//
//   join()      → makes a random participant ID (no name, no email) and records the consent
//   record()    → sends one record; if the server can't be reached, keeps it and tries later
//   withdraw()  → asks the server to delete everything this tester sent, then stops
//
// The choice is saved in localStorage, so the consent screen is only shown once.

const KEY = 'swar-netra-study-v1'
const QUEUE_KEY = 'swar-netra-study-queue-v1'
// Bump when the consent text changes in a way testers should agree to again.
export const CONSENT_VERSION = 1

export type RecordKind = 'calibration' | 'feedback'
type State = { choice: 'joined'; participant: string; version: number; feedbackSent?: boolean } | { choice: 'declined' }
type Queued = { kind: RecordKind | 'consent'; data: unknown }

const api = (path: string) => `${import.meta.env.BASE_URL}api/study/${path}`

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  return res.json()
}

function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage blocked: the study still works until the page is reloaded
  }
}

// A random ID: 16 random bytes as text. Nobody can work out who it belongs to.
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export class Study {
  private state: State | null = read<State | null>(KEY, null)

  // Shown the consent screen and answered it (for the current consent version)?
  get decided(): boolean {
    return this.state?.choice === 'declined' || (this.state?.choice === 'joined' && this.state.version === CONSENT_VERSION)
  }

  get joined(): boolean {
    return this.state?.choice === 'joined'
  }

  get participant(): string | null {
    return this.state?.choice === 'joined' ? this.state.participant : null
  }

  get feedbackSent(): boolean {
    return this.state?.choice === 'joined' && this.state.feedbackSent === true
  }

  join(): void {
    const participant = this.participant ?? randomId()
    this.state = { choice: 'joined', participant, version: CONSENT_VERSION }
    write(KEY, this.state)
    this.record('consent', { version: CONSENT_VERSION, adult: true, agreedAt: new Date().toISOString() })
  }

  decline(): void {
    this.state = { choice: 'declined' }
    write(KEY, this.state)
  }

  // Send one record. Resolves true once the server has it. If it can't be sent now (no
  // internet, or the free server still waking up), it waits in a queue for the next try.
  async record(kind: Queued['kind'], data: unknown): Promise<boolean> {
    if (!this.joined) return false
    write(QUEUE_KEY, [...read<Queued[]>(QUEUE_KEY, []), { kind, data }])
    const ok = await this.sendQueued()
    if (ok && kind === 'feedback' && this.state?.choice === 'joined') {
      this.state.feedbackSent = true
      write(KEY, this.state)
    }
    return ok
  }

  // Try to send everything waiting in the queue, oldest first. True if the queue is now empty.
  // One try at a time: two overlapping tries would send the same record twice.
  private chain: Promise<boolean> = Promise.resolve(true)
  sendQueued(): Promise<boolean> {
    this.chain = this.chain.then(() => this.flush())
    return this.chain
  }

  private async flush(): Promise<boolean> {
    const participant = this.participant
    if (!participant) return false
    const queue = read<Queued[]>(QUEUE_KEY, [])
    while (queue.length) {
      try {
        await post('records', { participant, ...queue[0] })
      } catch {
        write(QUEUE_KEY, queue)
        return false
      }
      queue.shift()
    }
    write(QUEUE_KEY, null)
    return true
  }

  // Leave the study: delete this tester's records on the server, forget the ID.
  async withdraw(): Promise<number> {
    const participant = this.participant
    if (!participant) return 0
    const { deleted } = (await post('withdraw', { participant })) as { deleted: number }
    write(QUEUE_KEY, null)
    this.decline()
    return deleted
  }
}
