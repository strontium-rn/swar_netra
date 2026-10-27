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
//   4. Replies: phone reply → laptop (which asks for news every few seconds) + the other phones.
//   5. Serving the app's files (the built `dist/` folder), so one server does everything.
//   6. User study: saves calibration results and feedback from testers who agreed, and lets
//      the researcher download them (see "User study" below).
//
// Run: npm run server   (after npm run build)
//
// Settings (optional environment variables):
//   PORT           port to listen on (default 8787)
//   DATA_DIR       where keys and pairings are saved (default server/data, never commit it)
//   VAPID_SUBJECT  contact link sent to the push service (default: the GitHub repo)
//   DATABASE_URL   save everything in this Postgres database instead of files (for hosting)
//   ADMIN_TOKEN    password for downloading the study data (no token = download switched off)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import webpush from 'web-push'
import { addStudyRecord, allStudyRecords, deleteParticipant, loadStore, saveStore, storageName, type Household, type Phone, type StudyRecord } from './store.ts'

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

// ---- Replies waiting for the laptop ("polling") ----
// The laptop asks every few seconds: "anything new after number N?". We first used one
// held-open connection (Server-Sent Events) instead, but some networks and tunnels hold
// such a stream back, and then replies never arrived. Plain short requests work everywhere.
// Kept in memory only: a reply older than 10 minutes is no use to the child anyway.
type Waiting = { n: number; at: number; messageId: string; data: string }
const waiting = new Map<string, Waiting[]>()
let counter = Date.now() // keeps growing, also across server restarts
const KEEP_MS = 10 * 60_000

function tellLaptop(householdId: string, messageId: string, data: string) {
  const list = (waiting.get(householdId) ?? []).filter((r) => Date.now() - r.at < KEEP_MS)
  list.push({ n: ++counter, at: Date.now(), messageId, data })
  waiting.set(householdId, list.slice(-50))
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
    return send(res, 200, { phoneId, phoneSecret })
  }

  if (route === 'POST /api/phones/delete') {
    const body = await readJson(req)
    const { h, phoneId } = phoneOf(body)
    delete h.phones[phoneId]
    await saveStore(store)
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
    tellLaptop(householdId, messageId, data)
    // Tell the other parents too, so they know it's handled (and don't all come running).
    await pushToPhones(householdId, { type: 'reply', id: messageId, data }, phoneId)
    return send(res, 200, { ok: true })
  }

  // The laptop asks for news: replies after number `after`, plus the current list of phones.
  // `after` missing (page just opened) → no old replies, only the number to continue from.
  if (route === 'POST /api/events') {
    const body = await readJson(req)
    const h = laptopOf(body)
    const list = waiting.get(String(body.householdId)) ?? []
    const after = typeof body.after === 'number' ? body.after : null
    return send(res, 200, {
      last: list.at(-1)?.n ?? counter,
      phones: phoneList(h),
      replies: after === null ? [] : list.filter((r) => r.n > after).map(({ messageId, data }) => ({ messageId, data })),
    })
  }

  // ---- User study ----
  // Only from testers who said yes on the consent screen (the app checks that before
  // sending). Records carry a random participant ID: no names, emails or IP addresses.

  if (route === 'POST /api/study/records') {
    limitStudyRate(req)
    const body = await readJson(req)
    const participant = participantOf(body)
    const kind = String(body.kind)
    if (!STUDY_KINDS.includes(kind as StudyRecord['kind'])) throw new HttpError(400, 'Unknown record kind')
    if (typeof body.data !== 'object' || body.data === null) throw new HttpError(400, 'No data')
    await addStudyRecord({ participant, kind: kind as StudyRecord['kind'], data: body.data })
    return send(res, 200, { ok: true })
  }

  // "Leave the study": delete everything this tester sent.
  if (route === 'POST /api/study/withdraw') {
    limitStudyRate(req)
    const deleted = await deleteParticipant(participantOf(await readJson(req)))
    return send(res, 200, { deleted })
  }

  // The researcher's download: everything, as JSON (or CSV for a spreadsheet: ?format=csv).
  // Protected by ADMIN_TOKEN, sent as "Authorization: Bearer <token>" or ?token=<token>.
  if (route === 'GET /api/study/export') {
    const given = req.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('token')
    if (!ADMIN_HASH || !matches(given, ADMIN_HASH)) throw new HttpError(403, 'Wrong or missing admin token')
    const records = await allStudyRecords()
    if (url.searchParams.get('format') === 'csv') {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="swar-netra-study.csv"', 'cache-control': 'no-store' })
      return void res.end(toCsv(records))
    }
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="swar-netra-study.json"', 'cache-control': 'no-store' })
    return void res.end(JSON.stringify(records, null, 1))
  }

  throw new HttpError(404, 'No such API')
}

// ---- User study helpers ----

const STUDY_KINDS: StudyRecord['kind'][] = ['consent', 'calibration', 'feedback']
const ADMIN_HASH = process.env.ADMIN_TOKEN ? hash(process.env.ADMIN_TOKEN) : null

function participantOf(body: Record<string, unknown>): string {
  const id = body.participant
  if (typeof id !== 'string' || !/^[\w-]{16,40}$/.test(id)) throw new HttpError(400, 'Bad participant ID')
  return id
}

// At most 20 study requests per minute from one address: stops someone filling the
// database with junk. The address is only kept in memory for this, never saved.
const studyHits = new Map<string, number[]>()
function limitStudyRate(req: IncomingMessage) {
  // Behind a host like Render, the real address is the first one in X-Forwarded-For.
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim()
  const now = Date.now()
  const recent = (studyHits.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= 20) throw new HttpError(429, 'Too many requests, try again in a minute')
  recent.push(now)
  studyHits.set(ip, recent)
}

// One row per record. Nested values are flattened into columns like "score.hitRate", so a
// spreadsheet can sort and average them; lists stay as JSON text in one cell.
function toCsv(records: StudyRecord[]): string {
  const flat = records.map((r) => {
    const row: Record<string, string> = { at: r.at, participant: r.participant, kind: r.kind }
    const walk = (value: unknown, path: string) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k)
      } else if (typeof value === 'string') {
        // A typed comment starting with "=" would run as a formula in Excel ("CSV injection"):
        // a leading ' makes the spreadsheet show it as plain text.
        row[path] = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
      } else row[path] = JSON.stringify(value)
    }
    walk(r.data, '')
    return row
  })
  const columns = [...new Set(flat.flatMap((row) => Object.keys(row)))]
  const cell = (v = '') => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return [columns.join(','), ...flat.map((row) => columns.map((c) => cell(row[c])).join(','))].join('\n') + '\n'
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
  // One line per API call (path and result only: never secrets or contents). The laptop's
  // regular "anything new?" checks are left out, or they'd drown everything else.
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/events') {
    res.on('finish', () => console.log(`${new Date().toLocaleTimeString()} ${req.method} ${url.pathname} → ${res.statusCode}`))
  }
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url)
    else if (req.method === 'GET') await serveFile(res, decodeURIComponent(url.pathname))
    else throw new HttpError(405, 'Method not allowed')
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (status === 500) console.error(err)
    if (!res.headersSent) send(res, status, { error: err instanceof HttpError ? err.message : 'Server error' })
  }
}).listen(PORT, () => console.log(`Swar Netra server on http://localhost:${PORT} (saving to ${storageName})`))
