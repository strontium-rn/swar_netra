// Phone alerts, laptop side: send the child's words to the parents' phones, and hear back.
//
//   setUp()   → asks the server for a new "household", makes the secret key, saves both
//   link()    → the pairing link shown as a QR code (household + join code + key)
//   say()     → collects the child's words and sends them as ONE message once the child pauses
//   send()    → seals a message and posts it to the server, which pushes it to the phones
//   replies   → every few seconds we ask the server for news ("Mum is coming", phone list)
//
// Pairing details are saved in localStorage, so alerts keep working after a reload.

import { open, newKey, seal, type ChildMessage, type ParentReply } from './secureChannel.ts'

const KEY = 'swar-netra-alerts-v1'
const SAME_WORD_MS = 20_000 // the same word again within 20 s isn't sent again (no spam)
// Grouping: a child often looks around and picks several words in a row. One notification
// per word buzzes the parent's phone every second, so we wait for a pause and send them together.
const QUIET_MS = 6_000 // send once no new word has come for this long...
const MAX_WAIT_MS = 15_000 // ...but never hold a word longer than this
const MAX_WORDS = 5 // more than this in one message is hard to read on a phone
const POLL_MS = 3_000 // how often we ask the server for replies: a reply shows within 3 s

type Pairing = { householdId: string; laptopSecret: string; joinSecret: string; key: string }
export type SendResult = 'sent' | 'no-phones' | 'failed' | 'skipped'
export type PhoneInfo = { id: string; name: string }
export type Word = { label: string; icon: string; speak: string }

// Several words → one message: "💬 🍎 Hungry · 💧 Water", spoken "I'm hungry. Water."
function combine(words: Word[], urgent: boolean): Omit<ChildMessage, 'at'> {
  if (words.length === 1) return { ...words[0], urgent }
  return {
    label: words.map((w) => `${w.icon} ${w.label}`).join(' · '),
    icon: urgent ? words.find((w) => w.icon)?.icon ?? '💬' : '💬',
    speak: words.map((w) => w.speak).join(' '),
    urgent,
  }
}

const api = (path: string) => `${import.meta.env.BASE_URL}api/${path}`

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  return res.json()
}

export class PhoneAlerts {
  private pairing: Pairing | null = load()
  private timer: ReturnType<typeof setTimeout> | null = null
  private after: number | null = null // the last reply number we've seen (null = just started)
  private messages = new Map<string, ChildMessage>() // sent, by server id (to match replies)
  private recent = new Map<string, number>() // word → when it was last picked (same-word skip)
  private waitingWords: Word[] = [] // picked but not sent yet (waiting for a pause)
  private firstWaitingAt = 0
  private quietTimer: ReturnType<typeof setTimeout> | undefined
  private waitingResult: ((r: SendResult) => void)[] = []
  phones: PhoneInfo[] = []
  online = false // did the last check with the server work?

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
    this.stop()
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

  get waiting(): boolean {
    return this.waitingWords.length > 0
  }

  // The child picked a word. Normal words wait for a pause (see QUIET_MS) and go out
  // together; an urgent word (Help) goes out right away, taking any waiting words with it.
  // Resolves with what finally happened to this word.
  say(word: Word, urgent: boolean): Promise<SendResult> {
    if (!this.pairing) return Promise.resolve('skipped')
    const now = Date.now()
    if (now - (this.recent.get(word.label) ?? 0) < SAME_WORD_MS) return Promise.resolve('skipped')
    this.recent.set(word.label, now)
    if (!this.waitingWords.some((w) => w.label === word.label)) this.waitingWords.push(word)
    if (this.waitingWords.length === 1) this.firstWaitingAt = now
    const result = new Promise<SendResult>((resolve) => this.waitingResult.push(resolve))
    clearTimeout(this.quietTimer)
    const waitLeft = Math.min(QUIET_MS, this.firstWaitingAt + MAX_WAIT_MS - now)
    if (urgent || this.waitingWords.length >= MAX_WORDS || waitLeft <= 0) this.flush(urgent)
    else this.quietTimer = setTimeout(() => this.flush(false), waitLeft)
    return result
  }

  // Send everything that is waiting, as one message.
  private async flush(urgent: boolean): Promise<void> {
    clearTimeout(this.quietTimer)
    const words = this.waitingWords
    const done = this.waitingResult
    this.waitingWords = []
    this.waitingResult = []
    if (words.length === 0) return
    // An urgent word goes first, so it's the first thing the parent reads.
    const ordered = urgent ? [words[words.length - 1], ...words.slice(0, -1)] : words
    const result = await this.send(combine(ordered, urgent))
    if (result === 'failed') for (const w of words) this.recent.delete(w.label) // let the child try again right away
    for (const resolve of done) resolve(result)
  }

  // Seal one message and hand it to the server (also used by "Send a test alert").
  async send(message: Omit<ChildMessage, 'at'>): Promise<SendResult> {
    if (!this.pairing) return 'skipped'
    const full: ChildMessage = { ...message, at: Date.now() }
    try {
      const { messageId, delivered } = await post<{ messageId: string; delivered: number }>('messages', {
        householdId: this.pairing.householdId,
        laptopSecret: this.pairing.laptopSecret,
        urgent: full.urgent,
        data: await seal(this.pairing.key, full),
      })
      this.messages.set(messageId, full)
      return delivered > 0 ? 'sent' : 'no-phones'
    } catch {
      return 'failed'
    }
  }

  // Ask the server for news, again and again ("polling"). Why not keep one connection
  // open and let the server write into it (Server-Sent Events)? We did, but some networks
  // and tunnels hold such a stream back, and replies never arrived. Short ordinary requests
  // get through everywhere; the cost is a reply showing up to 3 s late.
  private connect(): void {
    this.stop()
    this.after = null
    const poll = async () => {
      await this.check()
      if (this.pairing) this.timer = setTimeout(poll, POLL_MS)
    }
    poll()
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async check(): Promise<void> {
    const p = this.pairing
    if (!p) return
    try {
      const news = await post<{ last: number; phones: PhoneInfo[]; replies: { messageId: string; data: string }[] }>('events', {
        householdId: p.householdId,
        laptopSecret: p.laptopSecret,
        after: this.after,
      })
      if (p !== this.pairing) return // turned off (or set up again) while we were asking
      this.after = news.last
      // Parent names are sealed too: only we can read them.
      const phones = await Promise.all(news.phones.map(async (ph) => ({ id: ph.id, name: await open<string>(p.key, ph.name).catch(() => 'A phone') })))
      const changed = !this.online || JSON.stringify(phones) !== JSON.stringify(this.phones)
      this.phones = phones
      this.online = true
      if (changed) this.onChange()
      for (const r of news.replies) {
        const reply = await open<ParentReply>(p.key, r.data).catch(() => null)
        if (reply) this.onReply(reply, this.messages.get(r.messageId))
      }
    } catch {
      if (this.online) {
        this.online = false
        this.onChange()
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
