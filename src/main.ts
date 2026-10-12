// Entry point: wires the pipeline modules together and runs the main loop.
// It does no real work itself. Each module does one job; main.ts connects them.

import './style.css'
import { startCamera } from './camera.ts'
import { LandmarkDetector } from './landmarks.ts'
import { drawPoints } from './debugView.ts'

const video = document.querySelector<HTMLVideoElement>('#video')!
const overlay = document.querySelector<HTMLCanvasElement>('#overlay')!
const status = document.querySelector<HTMLDivElement>('#status')!

async function main() {
  status.textContent = 'Starting camera…'
  await startCamera(video)

  // Make the canvas the same pixel size as the video so points line up.
  overlay.width = video.videoWidth
  overlay.height = video.videoHeight

  status.textContent = 'Loading face model…'
  const detector = await LandmarkDetector.create()

  let lastVideoTime = -1
  let frames = 0
  let fpsTimer = performance.now()

  // The main loop. requestAnimationFrame calls `loop` right before each screen
  // refresh (60–120 times a second on a Mac).
  function loop() {
    // The camera only gives ~30 new frames per second, but the screen refreshes faster.
    // Skip the work if the video frame hasn't changed, so we don't analyze the same frame twice.
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime
      const points = detector.detect(video, performance.now())
      drawPoints(overlay, points)
      frames++
    }

    // Once a second, show how many frames per second (FPS) we analyzed.
    const now = performance.now()
    if (now - fpsTimer >= 1000) {
      status.textContent = `Tracking: ${frames} FPS`
      frames = 0
      fpsTimer = now
    }

    requestAnimationFrame(loop)
  }
  loop()
}

main().catch((err) => {
  // If anything fails (e.g. camera permission denied), show it on screen instead of failing silently.
  status.textContent = `Error: ${err.message ?? err}`
  console.error(err)
})
