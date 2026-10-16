// Swar Netra Parent: the phone app.
//
//   Not paired  → explains how to scan the QR code on the laptop.
//   Pairing     → opened from the QR link: asks the parent's name, turns on notifications.
//   Paired      → recent messages from the child, with "Coming" / "5 minutes" buttons.
//
// Notifications themselves are handled by the service worker (public/phone-sw.js), which
// runs even when this page is closed. Both share their data through IndexedDB.

import '../style.css'
import './phone.css'
import { fromBase64Url, seal, REPLY_TEXT, type Reply } from '../secureChannel.ts'

type Pairing = { householdId: string; phoneId: string; phoneSecret: string; key: string; name: string }
type Message = { id: string; label: string; icon: string; speak: string; urgent: boolean; at: number; answered?: { name: string; reply: Reply } }

const app = document.querySelector<HTMLElement>('#app')!
const BASE = import.meta.env.BASE_URL

// ---- Storage shared with the service worker ----
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('swar-netra-phone', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function get<T>(key: string): Promise<T | undefined> {
  const d = await db()
  return new Promise((resolve) => {
    const req = d.transaction('kv').objectStore('kv').get(key)
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => resolve(undefined)
  })
}
async function set(key: string, value: unknown): Promise<void> {
  const d = await db()
  return new Promise((resolve) => {
    const tx = d.transaction('kv', 'readwrite')
    if (value === undefined) tx.objectStore('kv').delete(key)
    else tx.objectStore('kv').put(value, key)
    tx.oncomplete = () => resolve()
  })
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  return res.json()
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}
const button = (text: string, onclick: () => void, className = '') => el('button', { textContent: text, onclick, className, type: 'button' })

// The service worker gets its own scope ("./phone"), separate from the laptop app's worker.
const worker = navigator.serviceWorker?.register(`${BASE}phone-sw.js`, { scope: `${BASE}phone` })

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms))])
}

// "#pair=household.joinSecret.key" from the QR code.
function pairingFromLink(): { householdId: string; joinSecret: string; key: string } | null {
  const m = location.hash.match(/^#pair=([\w-]+)\.([\w-]+)\.([\w-]+)$/)
  return m ? { householdId: m[1], joinSecret: m[2], key: m[3] } : null
}

async function render() {
  const pairing = await get<Pairing>('pairing')
  const link = pairingFromLink()
  if (link && link.householdId !== pairing?.householdId) return renderJoin(link, pairing)
  if (link) history.replaceState(null, '', location.pathname) // already paired: tidy the address
  if (!pairing) return renderWelcome()
  renderPaired(pairing)
}

function renderWelcome() {
  app.replaceChildren(
    el('p', { textContent: 'Get a notification on this phone whenever the child says something with Swar Netra, and reply that you’re coming.' }),
    el('ol', {}, el('li', { textContent: 'On the laptop, click “Phone alerts”.' }), el('li', { textContent: 'Scan the QR code with this phone’s camera.' })),
  )
}

function renderJoin(link: { householdId: string; joinSecret: string; key: string }, existing: Pairing | undefined) {
  if (fromBase64Url(link.key).length !== 32) return app.replaceChildren(el('p', { textContent: 'This QR code looks damaged. Please scan it again.' }))
  const name = el('input', { value: existing?.name ?? '', placeholder: 'e.g. Mum', maxLength: 20 })
  const status = el('p', { className: 'muted' })
  const go = button('Turn on alerts', async () => {
    if (!name.value.trim()) return name.focus()
    go.disabled = true
    try {
      status.textContent = 'Asking for permission…'
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked. Allow them in the browser settings for this site, then try again.')
      // The push "address": the browser asks Google's push service for a unique address
      // for this phone, signed with our server's public key (so only our server can use it).
      if (!worker || !('PushManager' in window)) throw new Error('This browser can’t receive notifications. Please open this link in Chrome.')
      const registration = await worker
      await navigator.serviceWorker.ready
      const { publicKey } = await fetch(`${BASE}api/vapid`).then((r) => r.json())
      status.textContent = 'Registering this phone for notifications…'
      // The first registration with Google's push service can be slow, or hang on a bad
      // connection. Never leave the parent staring at a frozen screen: give up after 30 s.
      const subscription = await withTimeout(
        registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) }),
        30_000,
        'The notification service didn’t answer. Check the internet connection and try again.',
      )
      status.textContent = 'Connecting…'
      const { phoneId, phoneSecret } = await post<{ phoneId: string; phoneSecret: string }>('phones', {
        householdId: link.householdId,
        joinSecret: link.joinSecret,
        subscription: subscription.toJSON(),
        name: await seal(link.key, name.value.trim()), // sealed: the server can't read names either
      })
      await set('pairing', { householdId: link.householdId, phoneId, phoneSecret, key: link.key, name: name.value.trim() } satisfies Pairing)
      await set('messages', [])
      history.replaceState(null, '', location.pathname) // remove the secret from the address bar
      render()
    } catch (err) {
      status.textContent = `⚠️ ${(err as Error).message}`
      go.disabled = false
    }
  })
  app.replaceChildren(
    el('h2', { textContent: existing ? 'Connect to a different laptop?' : 'Connect to the child’s laptop' }),
    el('label', { className: 'field' }, 'Your name (the child will hear it, e.g. “Mum is coming”)', name),
    go,
    status,
    el('p', { className: 'muted', textContent: 'Tip: in Chrome’s menu, choose “Add to Home screen” to get an app icon.' }),
  )
}

async function renderPaired(p: Pairing) {
  const messages = (await get<Message[]>('messages')) ?? []
  const list = messages.length
    ? el('ul', { className: 'messages' }, ...messages.map((m) => messageItem(p, m)))
    : el('p', { className: 'muted', textContent: 'No messages yet. Messages from the child will appear here.' })
  app.replaceChildren(
    el('p', { className: 'ok', textContent: `✓ Alerts are on. Replies are sent as “${p.name}”.` }),
    list,
    el(
      'div',
      { className: 'row' },
      button('Test notification', async () => {
        const r = await worker!
        r.showNotification('🔔 Test', { body: 'Notifications work on this phone.', icon: 'favicon.svg' })
      }, 'secondary'),
      button('Stop alerts on this phone', async () => {
        if (!confirm('Stop getting messages on this phone?')) return
        await post('phones/delete', { householdId: p.householdId, phoneId: p.phoneId, phoneSecret: p.phoneSecret }).catch(() => {})
        await (await (await worker!).pushManager.getSubscription())?.unsubscribe()
        await set('pairing', undefined)
        render()
      }, 'danger'),
    ),
  )
}

function messageItem(p: Pairing, m: Message): HTMLElement {
  const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const item = el('li', { className: m.urgent && !m.answered ? 'urgent' : '' }, el('span', { className: 'msg-icon', textContent: m.icon }), el('div', { className: 'msg-text' }, el('b', { textContent: m.label }), el('span', { className: 'muted', textContent: ` ${time} · “${m.speak}”` })))
  if (m.answered) {
    item.append(el('span', { className: 'answered', textContent: `✓ ${m.answered.name} ${REPLY_TEXT[m.answered.reply]}` }))
  } else {
    const replyWith = (kind: Reply) => async () => {
      try {
        await post('replies', { householdId: p.householdId, phoneId: p.phoneId, phoneSecret: p.phoneSecret, messageId: m.id, data: await seal(p.key, { messageId: m.id, reply: kind, name: p.name, at: Date.now() }) })
        const all = (await get<Message[]>('messages')) ?? []
        await set('messages', all.map((x) => (x.id === m.id ? { ...x, answered: { name: p.name, reply: kind } } : x)))
        render()
      } catch {
        alert('Not sent: no internet connection. Please try again.')
      }
    }
    item.append(el('div', { className: 'row' }, button('🏃 Coming', replyWith('coming')), button('⏳ 5 min', replyWith('wait'), 'secondary')))
  }
  return item
}

// Redraw when the service worker saved a new message, or the QR link changes.
navigator.serviceWorker?.addEventListener('message', () => render())
window.addEventListener('hashchange', () => render())
render()
