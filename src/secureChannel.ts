// Secure channel: end-to-end encryption between the laptop and the parents' phones.
//
// Messages travel laptop → our server → Google's push service → phone. Without this,
// our server could read "Toilet" or "It hurts". With it, the server only passes along
// sealed boxes it cannot open:
//
//   - The laptop makes a random secret KEY when phone alerts are set up.
//   - The key travels to the phone INSIDE THE QR CODE, in the part of the link after "#".
//     Browsers never send that part to any server, so the server never sees the key.
//   - Each message is locked with AES-GCM: the standard lock used by HTTPS and WhatsApp.
//     "GCM" also adds a seal: if anyone changes even one letter on the way, opening fails,
//     so a message can't be secretly altered either.
//
// The browser does the actual math (WebCrypto, `crypto.subtle`): fast, built in, and
// written by security experts. Rule #1 of security: never invent your own encryption.

// Bytes ↔ text that is safe inside a link (base64url: A-Z a-z 0-9 - _).
export function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

// A new random 256-bit key, as text (to put in the QR code and save).
export function newKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

// A random id/secret, e.g. for passwords between devices and the server.
export function randomToken(bytes = 16): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

function importKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64Url(key), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

// Lock: any data → sealed text. A fresh random "IV" (number used once) per message means
// the same word ("Help") looks different every time, so nobody can spot repeats.
export async function seal(key: string, data: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify(data))
  const locked = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(key), plain))
  const out = new Uint8Array(iv.length + locked.length)
  out.set(iv)
  out.set(locked, iv.length)
  return toBase64Url(out)
}

// Unlock. Throws if the key is wrong or the message was changed on the way.
export async function open<T>(key: string, sealed: string): Promise<T> {
  const bytes = fromBase64Url(sealed)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await importKey(key), bytes.slice(12))
  return JSON.parse(new TextDecoder().decode(plain)) as T
}

// What's inside the sealed boxes.
// What the laptop sends (sealed). `label` may list several words when they were grouped;
// `at` is when it was sent (laptop clock), so the phone can show the time.
export type ChildMessage = { label: string; icon: string; speak: string; urgent: boolean; at: number }
export type Reply = 'coming' | 'wait'
export type ParentReply = { messageId: string; reply: Reply; name: string; at: number }

export const REPLY_TEXT: Record<Reply, string> = {
  coming: 'is coming',
  wait: 'will come in 5 minutes',
}
