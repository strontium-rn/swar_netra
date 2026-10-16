// Phone alerts, laptop side: send the child's words to the parents' phones, and hear back.
//
//   setUp()   → asks the server for a new "household", makes the secret key, saves both
//   link()    → the pairing link shown as a QR code (household + join code + key)
//   send()    → seals the word and posts it to the server, which pushes it to the phones
//   replies   → a live connection (EventSource) on which the server tells us "Mum is coming"
//
// Pairing details are saved in localStorage, so alerts keep working after a reload.

import { open, newKey, seal, type ChildMessage, type ParentReply } from './secureChannel.ts'

const KEY = 'swar-netra-alerts-v1'
const SAME_WORD_MS = 20_000 // the same word again within 20 s isn't sent again (no spam)

type Pairing = { householdId: string; laptopSecret: string; joinSecret: string; key: string }
export type SendResult = 'sent' | 'no-phones' | 'failed' | 'skipped'
export type PhoneInfo = { id: string; name: string }

const api = (path: string) => `${import.meta.env.BASE_URL}api/${path}`

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  return res.json()
}

export class PhoneAlerts {
  private pairing: Pairing | null = load()
  private events: EventSource | null = null
  private messages = new Map<string, ChildMessage>() // sent, by server id (to match replies)
  private lastSent = { label: '', at: 0 }
  phones: PhoneInfo[] = []
  online = false // is the live connection to the server open?

  onReply: (reply: ParentReply, message: ChildMessage | undefined) => void = () => {}
  onChange: () => void = () => {}

  get enabled(): boolean {
    return this.pairing !== null
  }

  start(): void {
    if (this.pairing) this.connect()
  }

  async setUp(): Promise<void> {
    const ids = await post<Omit<Pairing, 'key'>>('households', {})
    this.pairing = { ...ids, key: newKey() } // the key is made HERE: the server never has it
    save(this.pairing)
    this.connect()
  }

  async turnOff(): Promise<void> {
    if (!this.pairing) return
    await post('households/delete', { householdId: this.pairing.householdId, laptopSecret: this.pairing.laptopSecret }).catch(() => {})
    this.events?.close()
    this.events = null
    this.pairing = null
    this.phones = []
    save(null)
    this.onChange()
  }

  // The link inside the QR code. Everything after "#" stays on the phone: browsers never
  // send it to a server. That's how the key reaches the phone without the server seeing it.
  link(): string {
    const p = this.pairing!
    return `${location.origin}${import.meta.env.BASE_URL}phone.html#pair=${p.householdId}.${p.joinSecret}.${p.key}`
  }

  async send(word: { label: string; icon: string; speak: string }, urgent: boolean): Promise<SendResult> {
    if (!this.pairing) return 'skipped'
    const now = Date.now()
    if (word.label === this.lastSent.label && now - this.lastSent.at < SAME_WORD_MS) return 'skipped'
    this.lastSent = { label: word.label, at: now }
    const message: ChildMessage = { label: word.label, icon: word.icon, speak: word.speak, urgent, at: now }
    try {
      const { messageId, delivered } = await post<{ messageId: string; delivered: number }>('messages', {
        householdId: this.pairing.householdId,
        laptopSecret: this.pairing.laptopSecret,
        urgent,
        data: await seal(this.pairing.key, message),
      })
      this.messages.set(messageId, message)
      return delivered > 0 ? 'sent' : 'no-phones'
    } catch {
      this.lastSent = { label: '', at: 0 } // let the child try again right away
      return 'failed'
    }
  }

  // Live connection: the server writes events into it as they happen.
  private connect(): void {
    const p = this.pairing!
    this.events?.close()
    const events = new EventSource(`${api('events')}?household=${encodeURIComponent(p.householdId)}&secret=${encodeURIComponent(p.laptopSecret)}`)
    this.events = events
    events.onopen = () => {
      this.online = true
      this.onChange()
    }
    // On error the browser retries by itself every few seconds; we just show "offline".
    events.onerror = () => {
      this.online = false
      this.onChange()
    }
    events.onmessage = async (e) => {
      const event = JSON.parse(e.data)
      if (event.type === 'phones') {
        // Parent names are sealed too: only we can read them.
        this.phones = await Promise.all(
          (event.phones as PhoneInfo[]).map(async (ph) => ({ id: ph.id, name: await open<string>(p.key, ph.name).catch(() => 'A phone') })),
        )
        this.onChange()
      } else if (event.type === 'reply') {
        const reply = await open<ParentReply>(p.key, event.data).catch(() => null)
        if (reply) this.onReply(reply, this.messages.get(event.messageId))
      }
    }
  }
}

function load(): Pairing | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null')
  } catch {
    return null
  }
}

function save(p: Pairing | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p))
    else localStorage.removeItem(KEY)
  } catch {
    // storage blocked: alerts work until the page is reloaded
  }
}
