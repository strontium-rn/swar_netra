// Phone service worker: the part of the parent app that runs even when the app is CLOSED.
//
// When a push arrives, Android wakes this script up (for a few seconds). It:
//   1. unseals the message with the key from the QR code (saved in IndexedDB),
//   2. saves it, so the app can list it later,
//   3. shows a notification with "Coming" / "5 minutes" buttons,
//   4. when a button is tapped, sends the sealed reply to the server.
//
// Plain JavaScript (not bundled by Vite), so it has its own small copies of the
// storage and unsealing helpers that the app page also uses (src/phone/phone.ts).

const DB = 'swar-netra-phone'
const REPLY_TEXT = { coming: 'is coming', wait: 'will come in 5 minutes' }

// ---- Storage (IndexedDB: the only storage a service worker can use) ----
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function get(key) {
  const d = await db()
  return new Promise((resolve) => {
    const req = d.transaction('kv').objectStore('kv').get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(undefined)
  })
}
async function set(key, value) {
  const d = await db()
  return new Promise((resolve) => {
    const tx = d.transaction('kv', 'readwrite')
    tx.objectStore('kv').put(value, key)
    tx.oncomplete = () => resolve()
  })
}

// ---- Sealing (same as src/secureChannel.ts) ----
const fromB64 = (t) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const toB64 = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const importKey = (key) => crypto.subtle.importKey('raw', fromB64(key), 'AES-GCM', false, ['encrypt', 'decrypt'])
async function unseal(key, sealed) {
  const bytes = fromB64(sealed)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await importKey(key), bytes.slice(12))
  return JSON.parse(new TextDecoder().decode(plain))
}
async function seal(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const locked = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(key), new TextEncoder().encode(JSON.stringify(data))))
  const out = new Uint8Array(12 + locked.length)
  out.set(iv)
  out.set(locked, 12)
  return toB64(out)
}

// ---- Messages list (newest first, last 30) ----
async function updateMessage(id, change) {
  const list = (await get('messages')) ?? []
  const i = list.findIndex((m) => m.id === id)
  if (i >= 0) list[i] = { ...list[i], ...change }
  else list.unshift({ id, ...change })
  await set('messages', list.slice(0, 30))
  // Tell any open app window to redraw.
  for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'update' })
}

// Send a reply ("coming" / "wait") for a message. Used by the notification buttons.
async function reply(messageId, kind) {
  const p = await get('pairing')
  if (!p) return
  const data = await seal(p.key, { messageId, reply: kind, name: p.name, at: Date.now() })
  const res = await fetch('api/replies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ householdId: p.householdId, phoneId: p.phoneId, phoneSecret: p.phoneSecret, messageId, data }),
  })
  if (!res.ok) throw new Error('reply failed')
  await updateMessage(messageId, { answered: { name: p.name, reply: kind } })
}

// ---- Events ----

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const p = await get('pairing')
      const push = event.data?.json()
      if (!p || !push) return
      if (push.type === 'message') {
        // One message can hold several words picked in a row ("💬 🍎 Hungry · 💧 Water"):
        // the laptop groups them, so this code shows it like any other message.
        const m = await unseal(p.key, push.data)
        const list = (await get('messages')) ?? []
        if (list.find((x) => x.id === push.id)?.answered) return // already handled
        await updateMessage(push.id, { label: m.label, icon: m.icon, speak: m.speak, urgent: m.urgent, at: m.at })
        // tag = message id: a repeat REPLACES the earlier notification instead of stacking up,
        // and renotify makes it ring again anyway (urgent repeats must be noticed).
        await self.registration.showNotification(`${m.icon} ${m.label}`, {
          body: m.urgent ? `URGENT: “${m.speak}”${push.repeat ? ` (reminder ${push.repeat})` : ''}` : `“${m.speak}”`,
          tag: push.id,
          renotify: true,
          requireInteraction: m.urgent, // urgent ones stay on screen until tapped
          vibrate: m.urgent ? [600, 200, 600, 200, 600] : [200],
          icon: 'favicon.svg',
          data: { id: push.id },
          actions: [
            { action: 'coming', title: '🏃 Coming' },
            { action: 'wait', title: '⏳ 5 minutes' },
          ],
        })
      } else if (push.type === 'reply') {
        // Another parent answered: replace the alert with "Dad is coming", quietly.
        const r = await unseal(p.key, push.data)
        await updateMessage(push.id, { answered: { name: r.name, reply: r.reply } })
        await self.registration.showNotification(`✓ ${r.name} ${REPLY_TEXT[r.reply]}`, {
          tag: push.id,
          silent: true,
          icon: 'favicon.svg',
          data: { id: push.id },
        })
      }
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const id = event.notification.data?.id
  event.waitUntil(
    (async () => {
      if (event.action === 'coming' || event.action === 'wait') {
        try {
          await reply(id, event.action)
          return
        } catch {
          // no internet: fall through and open the app, where the parent can try again
        }
      }
      // Tapped the notification itself: open the app (or bring it to the front).
      const windows = await self.clients.matchAll({ type: 'window' })
      if (windows[0]) return windows[0].focus()
      return self.clients.openWindow('phone.html')
    })(),
  )
})
