// Swar Netra relay server: passes the child's messages from the laptop to the parents'
// phones, and the parents' replies back to the laptop.
//
// It never sees what is said: messages arrive sealed (see src/secureChannel.ts) and leave
// sealed. It only knows WHICH household a sealed box belongs to, and whether it's urgent.
//
// Jobs:
//   1. Pairing: a laptop creates a "household"; phones join it with the code from the QR.
//   2. Forwarding: laptop message → Web Push → every phone in the household.
//   3. Urgent repeats: an urgent message (Help) is re-sent every minute until someone replies.
//   4. Replies: phone reply → laptop (live, over an open connection) + the other phones.
//   5. Serving the app's files (the built `dist/` folder), so one server does everything.
//
// Run: npm run server   (after npm run build)
//
// Settings (optional environment variables):
//   PORT           port to listen on (default 8787)
//   DATA_DIR       where keys and pairings are saved (default server/data, never commit it)
//   VAPID_SUBJECT  contact link sent to the push service (default: the GitHub repo)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import webpush from 'web-push'
import { loadStore, saveStore, type Household, type Phone } from './store.ts'

const PORT = Number(process.env.PORT ?? 8787)
const DIST = join(import.meta.dirname, '..', 'dist')
const REPEAT_MS = 60_000 // urgent messages: re-send every minute...
const MAX_REPEATS = 5 // ...at most 5 times
const MAX_PER_MINUTE = 30 // per household: stops a stuck loop from flooding the phones
const MAX_BODY = 16_384 // bytes: our requests are tiny; refuse anything big

const store = await loadStore()
webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'https://github.com/strontium-rn/swar_netra', store.vapid.publicKey, store.vapid.privateKey)

// ---- Small helpers ----

const token = (bytes = 16) => randomBytes(bytes).toString('base64url')
// We store only a HASH of each secret (a one-way fingerprint), like websites do with
// passwords: if the server's files ever leak, the secrets themselves aren't in them.
const hash = (secret: string) => createHash('sha256').update(secret).digest('base64url')
// Compare in constant time, so an attacker can't guess a secret letter by letter by
// measuring how long the comparison takes ("timing attack").
function matches(secret: unknown, stored: string): boolean {
  if (typeof secret !== 'string') return false
  const a = Buffer.from(hash(secret))
  const b = Buffer.from(stored)
  return a.length === b.length && timingSafeEqual(a, b)
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'Too big')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}')
  } catch {
    throw new HttpError(400, 'Not JSON')
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function household(id: unknown): Household {
  const h = typeof id === 'string' ? store.households[id] : undefined
  if (!h) throw new HttpError(404, 'Unknown household')
  return h
}

function laptopOf(body: Record<string, unknown>): Household {
  const h = household(body.householdId)
  if (!matches(body.laptopSecret, h.laptopHash)) throw new HttpError(403, 'Wrong laptop secret')
  return h
}

function phoneOf(body: Record<string, unknown>): { h: Household; phoneId: string; phone: Phone } {
  const h = household(body.householdId)
  const phoneId = String(body.phoneId)
  const phone = h.phones[phoneId]
  if (!phone || !matches(body.phoneSecret, phone.secretHash)) throw new HttpError(403, 'Unknown phone')
  return { h, phoneId, phone }
}

// ---- Live connection to the laptop ("Server-Sent Events") ----
// The laptop keeps one request open; the server writes a line into it whenever something
// happens (a reply arrived, a phone joined). Simpler than WebSockets, and the browser
// reconnects by itself if the connection drops.
const laptops = new Map<string, Set<ServerResponse>>()

function tellLaptop(householdId: string, event: unknown) {
  for (const res of laptops.get(householdId) ?? []) res.write(`data: ${JSON.stringify(event)}\n\n`)
}

const phoneList = (h: Household) => Object.entries(h.phones).map(([id, p]) => ({ id, name: p.name }))

// ---- Push to phones ----

type Push = { type: 'message'; id: string; urgent: boolean; data: string; repeat: number } | { type: 'reply'; id: string; data: string }

async function pushToPhones(householdId: string, payload: Push, except?: string): Promise<number> {
  const h = store.households[householdId]
  if (!h) return 0
  let delivered = 0
  await Promise.all(
    Object.entries(h.phones).map(async ([phoneId, phone]) => {
      if (phoneId === except) return
      try {
        // TTL: if the phone is off, Google keeps the message this long (1 hour) and delivers
        // it when the phone comes back. urgency 'high' wakes a sleeping phone right away.
        await webpush.sendNotification(phone.subscription, JSON.stringify(payload), { TTL: 3600, urgency: 'high' })
        delivered++
      } catch (err) {
        // 404/410 = this phone unsubscribed or the app was uninstalled: forget it.
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          delete h.phones[phoneId]
          await saveStore(store)
          tellLaptop(householdId, { type: 'phones', phones: phoneList(h) })
        } else {
          console.warn('push failed', status, (err as Error).message)
        }
      }
    }),
  )
  return delivered
}

// Messages waiting for a reply (in memory only: they matter for minutes, not days).
type OpenMessage = { householdId: string; data: string; urgent: boolean; repeats: number; timer?: NodeJS.Timeout }
const open = new Map<string, OpenMessage>()
const sentTimes = new Map<string, number[]>() // per household: recent send times, for the rate limit

// ---- Routes ----

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const route = `${req.method} ${url.pathname}`

  if (route === 'GET /api/vapid') return send(res, 200, { publicKey: store.vapid.publicKey })

  // 1. A laptop sets up phone alerts.
  if (route === 'POST /api/households') {
    const householdId = token(9)
    const laptopSecret = token()
    const joinSecret = token()
    store.households[householdId] = { laptopHash: hash(laptopSecret), joinHash: hash(joinSecret), phones: {}, createdAt: Date.now() }
    await saveStore(store)
    return send(res, 200, { householdId, laptopSecret, joinSecret })
  }

  // The laptop turns alerts off: forget the household and all its phones.
  if (route === 'POST /api/households/delete') {
    const body = await readJson(req)
    laptopOf(body)
    delete store.households[String(body.householdId)]
    await saveStore(store)
    return send(res, 200, { ok: true })
  }

  // 2. A phone joins, with the code from the QR and its push "address" (subscription).
  if (route === 'POST /api/phones') {
    const body = await readJson(req)
    const h = household(body.householdId)
    if (!matches(body.joinSecret, h.joinHash)) throw new HttpError(403, 'Wrong pairing code')
    const sub = body.subscription as webpush.PushSubscription
    if (!sub?.endpoint?.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) throw new HttpError(400, 'Bad subscription')
    const phoneId = token(9)
    const phoneSecret = token()
    h.phones[phoneId] = { secretHash: hash(phoneSecret), subscription: sub, name: String(body.name ?? '').slice(0, 400), addedAt: Date.now() }
    await saveStore(store)
    tellLaptop(String(body.householdId), { type: 'phones', phones: phoneList(h) })
    return send(res, 200, { phoneId, phoneSecret })
  }

  if (route === 'POST /api/phones/delete') {
    const body = await readJson(req)
    const { h, phoneId } = phoneOf(body)
    delete h.phones[phoneId]
    await saveStore(store)
    tellLaptop(String(body.householdId), { type: 'phones', phones: phoneList(h) })
    return send(res, 200, { ok: true })
  }

  // 3. The child said something: forward it to every phone.
  if (route === 'POST /api/messages') {
    const body = await readJson(req)
    const h = laptopOf(body)
    const householdId = String(body.householdId)
    const now = Date.now()
    const recent = (sentTimes.get(householdId) ?? []).filter((t) => now - t < 60_000)
    if (recent.length >= MAX_PER_MINUTE) throw new HttpError(429, 'Too many messages')
    sentTimes.set(householdId, [...recent, now])

    const id = token(9)
    const msg: OpenMessage = { householdId, data: String(body.data), urgent: body.urgent === true, repeats: 0 }
    open.set(id, msg)
    const delivered = await pushToPhones(householdId, { type: 'message', id, urgent: msg.urgent, data: msg.data, repeat: 0 })
    if (msg.urgent) {
      msg.timer = setInterval(async () => {
        msg.repeats++
        await pushToPhones(householdId, { type: 'message', id, urgent: true, data: msg.data, repeat: msg.repeats })
        if (msg.repeats >= MAX_REPEATS) stop(id)
      }, REPEAT_MS)
    }
    setTimeout(() => stop(id), 60 * 60_000) // forget after an hour either way
    return send(res, 200, { messageId: id, phones: Object.keys(h.phones).length, delivered })
  }

  // 4. A parent replied ("Coming").
  if (route === 'POST /api/replies') {
    const body = await readJson(req)
    const { phoneId } = phoneOf(body)
    const householdId = String(body.householdId)
    const messageId = String(body.messageId)
    stop(messageId) // someone answered: no more urgent repeats
    const data = String(body.data)
    tellLaptop(householdId, { type: 'reply', messageId, data })
    // Tell the other parents too, so they know it's handled (and don't all come running).
    await pushToPhones(householdId, { type: 'reply', id: messageId, data }, phoneId)
    return send(res, 200, { ok: true })
  }

  // The laptop's live connection.
  if (route === 'GET /api/events') {
    const h = laptopOf({ householdId: url.searchParams.get('household'), laptopSecret: url.searchParams.get('secret') })
    const householdId = url.searchParams.get('household')!
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(`data: ${JSON.stringify({ type: 'phones', phones: phoneList(h) })}\n\n`)
    const set = laptops.get(householdId) ?? new Set()
    set.add(res)
    laptops.set(householdId, set)
    // A comment line every 25 s keeps the connection alive through proxies and routers.
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    req.on('close', () => {
      clearInterval(ping)
      set.delete(res)
    })
    return
  }

  throw new HttpError(404, 'No such API')
}

function stop(messageId: string) {
  const msg = open.get(messageId)
  if (msg?.timer) clearInterval(msg.timer)
  open.delete(messageId)
}

// ---- Static files (the built app) ----

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
}

async function serveFile(res: ServerResponse, pathname: string) {
  // normalize() resolves "..", and we refuse anything that still tries to climb out of
  // dist/ ("path traversal": /../../server/data would otherwise expose our secrets).
  const path = normalize(join(DIST, pathname.endsWith('/') ? `${pathname}index.html` : pathname))
  if (!path.startsWith(DIST)) throw new HttpError(403, 'No')
  try {
    const file = await readFile(path)
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
    res.end(file)
  } catch {
    throw new HttpError(404, 'Not found')
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url)
    else if (req.method === 'GET') await serveFile(res, decodeURIComponent(url.pathname))
    else throw new HttpError(405, 'Method not allowed')
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (status === 500) console.error(err)
    if (!res.headersSent) send(res, status, { error: err instanceof HttpError ? err.message : 'Server error' })
  }
}).listen(PORT, () => console.log(`Swar Netra server on http://localhost:${PORT}`))
