// Self-hosting: put MediaPipe's engine and the face model inside our own site (public/mediapipe),
// instead of loading them from other servers. The service worker can then save them
// for offline use, and the app no longer depends on those servers being up and fast.
// Runs automatically before `npm run dev` and `npm run build`.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'

const OUT = 'public/mediapipe'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

mkdirSync(`${OUT}/wasm`, { recursive: true })

// The engine ships inside the npm package, so it always matches the installed version.
// Two variants: the browser picks the fast "SIMD" one if it can, the other is a fallback.
for (const name of ['vision_wasm_internal', 'vision_wasm_nosimd_internal']) {
  for (const ext of ['js', 'wasm']) {
    copyFileSync(`node_modules/@mediapipe/tasks-vision/wasm/${name}.${ext}`, `${OUT}/wasm/${name}.${ext}`)
  }
}

// The model isn't in the npm package: download it once, then reuse the local copy.
const model = `${OUT}/face_landmarker.task`
if (!existsSync(model)) {
  console.log('Downloading face model (3.8 MB)…')
  const res = await fetch(MODEL_URL)
  if (!res.ok) throw new Error(`Model download failed: ${res.status}`)
  writeFileSync(model, Buffer.from(await res.arrayBuffer()))
}
console.log('MediaPipe files ready in', OUT)
