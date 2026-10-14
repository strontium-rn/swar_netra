// Offline support: install the service worker (public/sw.js).
//
// Only in the built app, not in `npm run dev`: during development we WANT every
// change to load fresh, and a cache in the way would hide our edits.

export async function enableOffline(): Promise<void> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
    await navigator.serviceWorker.ready
    // On the very first visit the page loaded before the worker existed. Wait (briefly)
    // until the worker takes control, so the big MediaPipe files we load next pass
    // through it and get saved. On later visits it's already in control: no wait.
    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ])
    }
  } catch (err) {
    // Not fatal: the app still works online, just without offline support.
    console.warn('Offline support unavailable:', err)
  }
}
