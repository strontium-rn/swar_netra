// Service worker: a small script the browser keeps running in the background for this site.
// It sits between the page and the network, so it can answer requests from a local cache.
// Result: after the first visit, the app starts instantly and works with no internet.
//
// Strategy per kind of file:
// - Page (index.html): "stale-while-revalidate". Show the saved copy immediately, and fetch
//   a fresh one in the background for next time. Starting fast matters more than starting
//   with the very latest version.
// - Everything else (code, styles, MediaPipe engine, face model): "cache first". These files
//   never change under the same name (new code gets a new hashed file name), so a saved copy
//   is always correct.

const CACHE = 'swar-netra-v1' // bump to throw away everything saved by older versions

// The files a page needs: itself plus the scripts/styles/icons it links to.
async function assetsOf(html) {
  const links = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
  return links.filter((url) => !url.startsWith('http')) // our own files only
}

// Save a page AND all its files, before replacing the saved page. Otherwise a new page
// could be saved that points to code we don't have yet, and break offline.
async function savePage(cache, response) {
  const html = await response.clone().text()
  await cache.addAll(await assetsOf(html))
  await cache.put('./', response)
  // Tidy up: remove old code files that the new page no longer uses.
  const keep = new Set((await assetsOf(html)).map((u) => new URL(u, self.location).href))
  for (const req of await cache.keys()) {
    if (req.url.includes('/assets/') && !keep.has(req.url)) await cache.delete(req)
  }
}

// Install: save the page and its files right away.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await savePage(cache, await fetch('./', { cache: 'reload' }))
      await self.skipWaiting() // take over without waiting for old tabs to close
    })(),
  )
})

// Activate: delete caches from older versions, and start handling the open page now.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  // Server requests (phone alerts) must always go to the network: they're live data
  // (who is paired, has a parent replied?), so a saved copy would be wrong.
  if (url.pathname.startsWith(new URL('api/', self.registration.scope).pathname)) return

  if (request.mode === 'navigate') {
    // Only the board page itself is saved for offline. Other pages (the parents' phone app)
    // are left to the network and to their own worker.
    const home = new URL('./', self.registration.scope).pathname
    if (url.pathname !== home && url.pathname !== `${home}index.html`) return
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        const cached = await cache.match('./')
        const fresh = fetch(request)
          .then(async (response) => {
            if (response.ok) await savePage(cache, response.clone())
            return response
          })
          .catch(() => null) // offline: fine, we have the saved page
        if (cached) {
          event.waitUntil(fresh) // keep the background update alive after we answer
          return cached
        }
        return (await fresh) ?? new Response('Offline and not saved yet', { status: 503 })
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(request)
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok) await cache.put(request, response.clone())
      return response
    })(),
  )
})
