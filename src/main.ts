// Entry point: wires the pipeline modules together and runs the main loop.
// It does no real work itself. Each module does one job; main.ts connects them.
//
//   camera → landmarks → eye features → gaze model → smoothing → board hit-test → dwell → speech

import './style.css'
import { startCamera } from './camera.ts'
import { LandmarkDetector, type FaceFrame } from './landmarks.ts'
import { drawHeadGuide, drawPoints } from './debugView.ts'
import { computeEyeFeatures, type EyeFeatures } from './eyeFeatures.ts'
import { CALIBRATION_TARGETS, VALIDATION_TARGETS, recordAtTargets, toSamples } from './calibration.ts'
import { GazeModel, IRIS_LOOK_HEAD, IRIS_ONLY, type ScreenPoint } from './gazeModel.ts'
import { GazeSmoother } from './smoothing.ts'
import { scoreModel, type Score } from './evaluate.ts'
import { FrameStream } from './frameStream.ts'
import { averagePose, driftMessage, headPose, type HeadPose } from './headGuard.ts'
import { Board } from './board.ts'
import { DwellSelector } from './dwell.ts'
import { speak } from './speech.ts'
import { WORDS } from './vocabulary.ts'

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const video = $<HTMLVideoElement>('#video')
const overlay = $<HTMLCanvasElement>('#overlay')
const setupView = $<HTMLDivElement>('#setup')
const boardView = $<HTMLDivElement>('#board')
const status = $<HTMLDivElement>('#status')
const calibrateBtn = $<HTMLButtonElement>('#calibrate')
const recalibrateBtn = $<HTMLButtonElement>('#recalibrate')
const smoothToggle = $<HTMLInputElement>('#smooth')
const showDotToggle = $<HTMLInputElement>('#show-dot')
const report = $<HTMLDivElement>('#report')
const headWarning = $<HTMLDivElement>('#head-warning')
const messageIcon = $<HTMLSpanElement>('#message-icon')
const messageText = $<HTMLSpanElement>('#message-text')
const calibLayer = $<HTMLDivElement>('#calib-layer')
const gazeDot = $<HTMLDivElement>('#gaze-dot')

// ---- App state ----
// The app is always in exactly one mode. Writing it down explicitly (a "state machine")
// avoids bugs like the board reacting to your eyes while you're calibrating.
let mode: 'setup' | 'calibrating' | 'board' = 'setup'
let predictGaze: ((f: EyeFeatures) => ScreenPoint) | null = null // set by calibration
let headRef: HeadPose | null = null // head position during calibration

const stream = new FrameStream()
const smoother = new GazeSmoother()
const dwell = new DwellSelector()
const board = new Board($<HTMLElement>('#words'), WORDS)

async function main() {
  status.textContent = 'Starting camera…'
  await startCamera(video)

  // Make the canvas the same pixel size as the video so points line up.
  overlay.width = video.videoWidth
  overlay.height = video.videoHeight
  const aspect = video.videoWidth / video.videoHeight

  status.textContent = 'Loading face model…'
  const detector = await LandmarkDetector.create()
  status.textContent = 'Ready. Sit comfortably, keep your head still, then press Calibrate.'
  calibrateBtn.disabled = false

  let lastVideoTime = -1
  let lastFrameMs = performance.now()

  // The main loop. requestAnimationFrame calls `loop` right before each screen refresh.
  function loop() {
    // Skip the work if the camera hasn't produced a new frame yet.
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime
      const now = performance.now()
      const dt = (now - lastFrameMs) / 1000 // seconds since the previous frame
      lastFrameMs = now
      onFrame(detector.detect(video, now), now, dt, aspect)
    }
    requestAnimationFrame(loop)
  }
  loop()
}

// Everything that happens for one camera frame.
function onFrame(frame: FaceFrame | null, now: number, dt: number, aspect: number) {
  if (!frame) {
    drawPoints(overlay, null)
    drawHeadGuide(overlay, headRef, null, false)
    if (mode === 'board') {
      showWarning("Can't see your face")
      updateBoard(null, now)
    }
    return
  }

  const features = computeEyeFeatures(frame, aspect)
  const pose = headPose(frame, aspect)
  stream.publish({ features, pose })

  const drift = headRef ? driftMessage(headRef, pose, aspect) : null
  drawPoints(overlay, frame.points)
  drawHeadGuide(overlay, headRef, pose, drift === null)

  if (mode !== 'board' || !predictGaze) return

  // Gaze → smoothing → pixels on screen.
  let gaze = predictGaze(features)
  if (smoothToggle.checked) gaze = smoother.smooth(gaze, dt)
  // Clamp to 0..1 so the point never leaves the screen.
  const x = Math.min(1, Math.max(0, gaze.x)) * window.innerWidth
  const y = Math.min(1, Math.max(0, gaze.y)) * window.innerHeight
  gazeDot.style.transform = `translate(${x}px, ${y}px)`
  gazeDot.hidden = !showDotToggle.checked
  gazeDot.classList.toggle('paused', drift !== null)

  showWarning(drift)
  // Fail-safe: if the head is out of position, the gaze can't be trusted, so select nothing.
  updateBoard(drift ? null : board.wordAt(x, y), now)
}

// Dwell → fill animation → (when complete) speak.
function updateBoard(target: string | null, now: number) {
  const chosen = dwell.update(target, now)
  const progress = dwell.progress(now)
  board.showProgress(progress?.id ?? null, progress?.fraction ?? 0)

  if (chosen) {
    const word = WORDS.find((w) => w.id === chosen)!
    board.flash(chosen)
    messageIcon.textContent = word.icon
    messageText.textContent = word.label
    speak(word.speak)
  }
}

function showWarning(message: string | null) {
  headWarning.hidden = message === null
  if (message) headWarning.textContent = message
}

// ---- Calibration ----

async function calibrate() {
  mode = 'calibrating'
  calibrateBtn.disabled = true
  gazeDot.hidden = true
  try {
    // Full screen, so the dots cover the whole display. The browser only allows this
    // right after a click, which is why calibration starts from a button.
    await document.documentElement.requestFullscreen().catch(() => {})

    // Also record where the head is during calibration, for the head guard.
    const poses: HeadPose[] = []
    const stopPoses = stream.subscribe((info) => poses.push(info.pose))

    // 1. Learn: record at 16 spots, then train both recipes on the SAME data (a fair comparison).
    const calibration = await recordAtTargets(calibLayer, stream, CALIBRATION_TARGETS)
    const samples = toSamples(calibration)
    const models = [IRIS_ONLY, IRIS_LOOK_HEAD].map((set) => GazeModel.fit(samples, set))

    // 2. Test: 5 new spots the models have never seen.
    const validation = await recordAtTargets(calibLayer, stream, VALIDATION_TARGETS)
    stopPoses()
    const scores = models.map((m) => scoreModel(m, validation))

    // 3. Pick the best model SEPARATELY for each axis, then combine them:
    //    x from the model with the best left/right score, y from the best up/down one.
    const bestX = argmin(scores.map((s) => s.errX))
    const bestY = argmin(scores.map((s) => s.errY))
    predictGaze = (f) => ({ x: models[bestX].predict(f).x, y: models[bestY].predict(f).y })
    headRef = averagePose(poses)

    showReport(scores, bestX, bestY)
    setupView.hidden = true
    boardView.hidden = false
    mode = 'board'
  } catch (err) {
    mode = 'setup'
    boardView.hidden = true
    setupView.hidden = false
    status.textContent = `Calibration failed: ${(err as Error).message}`
  } finally {
    calibrateBtn.disabled = false
  }
}

calibrateBtn.addEventListener('click', calibrate)
recalibrateBtn.addEventListener('click', calibrate)

function argmin(values: number[]): number {
  return values.indexOf(Math.min(...values))
}

function showReport(scores: Score[], bestX: number, bestY: number) {
  // Convert % of screen to pixels too, since button sizes are in pixels.
  const fmt = (pct: number, screenPx: number) => `${pct.toFixed(1)}% (${Math.round((pct / 100) * screenPx)}px)`
  const used = (yes: boolean) => (yes ? ' class="used"' : '')
  const rows = scores
    .map(
      (s, i) => `<tr>
        <td>${s.name}</td>
        <td${used(i === bestX)}>${fmt(s.errX, window.innerWidth)}</td>
        <td${used(i === bestY)}>${fmt(s.errY, window.innerHeight)}</td>
        <td>${s.jitter.toFixed(1)}%</td>
        <td>${s.jitterSmoothed.toFixed(1)}%</td>
      </tr>`,
    )
    .join('')
  report.innerHTML = `<table>
    <tr><th>Model</th><th>Aim error ↔</th><th>Aim error ↕</th><th>Jitter</th><th>Jitter (smoothed)</th></tr>
    ${rows}
  </table>
  <p>Highlighted = used for that direction.</p>`
}

main().catch((err) => {
  // If anything fails (e.g. camera permission denied), show it on screen instead of failing silently.
  status.textContent = `Error: ${err.message ?? err}`
  console.error(err)
})
