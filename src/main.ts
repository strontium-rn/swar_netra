// Entry point: wires the pipeline modules together and runs the main loop.
// It does no real work itself. Each module does one job; main.ts connects them.
//
//   camera → landmarks → eye features → gaze model → smoothing → board hit-test → dwell → speech

import './style.css'
import { startCamera } from './camera.ts'
import { LandmarkDetector, type FaceFrame } from './landmarks.ts'
import { drawHeadGuide, drawPoints } from './debugView.ts'
import { computeEyeFeatures } from './eyeFeatures.ts'
import { runCalibrationFlow, type CalibrationResult } from './calibrationFlow.ts'
import { GazeModel, weightCount } from './gazeModel.ts'
import { GazeSmoother } from './smoothing.ts'
import { FrameStream } from './frameStream.ts'
import { driftMessage, headPose, type HeadPose } from './headGuard.ts'
import { Board } from './board.ts'
import { DwellSelector } from './dwell.ts'
import { speak } from './speech.ts'
import { findTile, pageTiles, tileColor, type PageId } from './vocabulary.ts'
import { loadCalibration, saveCalibration } from './storage.ts'

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const video = $<HTMLVideoElement>('#video')
const overlay = $<HTMLCanvasElement>('#overlay')
const welcome = $<HTMLDivElement>('#welcome')
const status = $<HTMLParagraphElement>('#status')
const calibrateBtn = $<HTMLButtonElement>('#calibrate')
const recalibrateBtn = $<HTMLButtonElement>('#recalibrate')
const fullscreenBtn = $<HTMLButtonElement>('#fullscreen')
const smoothToggle = $<HTMLInputElement>('#smooth')
const showDotToggle = $<HTMLInputElement>('#show-dot')
const accuracy = $<HTMLElement>('#accuracy')
const report = $<HTMLDivElement>('#report')
const headWarning = $<HTMLDivElement>('#head-warning')
const messageIcon = $<HTMLSpanElement>('#message-icon')
const messageText = $<HTMLSpanElement>('#message-text')
const pageTitle = $<HTMLDivElement>('#page-title')
const calibLayer = $<HTMLDivElement>('#calib-layer')
const gazeDot = $<HTMLDivElement>('#gaze-dot')

// ---- App state ----
// The app is always in exactly one mode. Writing it down explicitly (a "state machine")
// avoids bugs like the board reacting to your eyes while you're calibrating.
//   setup → calibrating → board  (and board → calibrating again on "Recalibrate")
let mode: 'setup' | 'calibrating' | 'board' = 'setup'
let xModel: GazeModel | null = null // predicts left/right (decides the word)
let yModel: GazeModel | null = null // predicts up/down (only used for the gaze dot)
let headRef: HeadPose | null = null // head position during calibration
let lastFaceMs = -Infinity // when a face was last seen

const stream = new FrameStream()
const smoother = new GazeSmoother()
const dwell = new DwellSelector()
const board = new Board($<HTMLElement>('#words'))

// After a word is spoken, wait this long (so the flash is visible), then return home.
// Every message then starts from the same place, which helps motor planning.
const RETURN_HOME_MS = 700

let page: PageId = 'home'

// Show a page of the board. The button that lands under the gaze is locked until
// the user looks away, so a page change never selects something by accident.
function showPage(next: PageId) {
  page = next
  const tiles = pageTiles(next).map((t) => t && { id: t.id, label: t.label, icon: t.icon, color: tileColor(t, next) })
  dwell.reset(board.setPage(tiles))
  const category = next === 'home' ? null : findTile(next)
  pageTitle.textContent = category ? `${category.icon} ${category.label}` : ''
}
showPage('home')

async function main() {
  status.textContent = 'Starting camera…'
  await startCamera(video)

  // Make the canvas the same pixel size as the video so points line up.
  overlay.width = video.videoWidth
  overlay.height = video.videoHeight
  const aspect = video.videoWidth / video.videoHeight

  status.textContent = 'Loading face model…'
  const detector = await LandmarkDetector.create()

  // A saved calibration means we can skip straight to the board.
  const saved = loadCalibration()
  if (saved) {
    try {
      xModel = GazeModel.fromJSON(saved.xModel)
      yModel = GazeModel.fromJSON(saved.yModel)
      headRef = saved.headRef
      accuracy.textContent = `Saved calibration · ${Math.round(saved.hitRate)}% hit rate`
      report.innerHTML = `<p>Calibrated ${new Date(saved.savedAt).toLocaleString()}.<br>Recalibrate to see the full report.</p>`
      enterBoard()
    } catch {
      // Saved data from an older version of the app: ignore it and calibrate fresh.
      xModel = yModel = headRef = null
    }
  }

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
  if (frame) lastFaceMs = now
  if (mode === 'setup') updateFaceCheck(now)

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

  if (mode !== 'board' || !xModel || !yModel) return

  // Gaze → smoothing → position on screen (as fractions, clamped to 0..1).
  let gaze = { x: xModel.predict(features).x, y: yModel.predict(features).y }
  if (smoothToggle.checked) gaze = smoother.smooth(gaze, dt)
  const x = Math.min(1, Math.max(0, gaze.x))
  const y = Math.min(1, Math.max(0, gaze.y))
  gazeDot.style.transform = `translate(${x * window.innerWidth}px, ${y * window.innerHeight}px)`
  gazeDot.hidden = !showDotToggle.checked
  gazeDot.classList.toggle('paused', drift !== null)

  showWarning(drift)
  // Fail-safe: if the head is out of position, the gaze can't be trusted, so select nothing.
  updateBoard(drift ? null : board.wordAt(x), now)
}

// Before calibrating, make sure the camera can see the face. Starting without a face
// would only produce a bad calibration, so the button stays disabled until then.
function updateFaceCheck(now: number) {
  const faceOk = now - lastFaceMs < 500
  calibrateBtn.disabled = !faceOk
  status.textContent = faceOk
    ? '✓ Face found. Sit comfortably about an arm’s length from the screen.'
    : 'Looking for your face… Make sure it is well lit and in the middle of the camera.'
  status.classList.toggle('ok', faceOk)
}

// Dwell → fill animation → (when complete) speak.
function updateBoard(target: string | null, now: number) {
  const chosen = dwell.update(target, now)
  const progress = dwell.progress()
  board.show(target, progress?.id ?? null, progress?.fraction ?? 0)

  if (!chosen) return
  const tile = findTile(chosen)
  if (!tile) return
  if (tile.kind === 'category') {
    showPage(tile.id) // open the category
  } else if (tile.kind === 'back') {
    showPage('home')
  } else {
    // A word: flash it, show it big for the listener, and say it.
    board.flash(tile.id)
    messageIcon.textContent = tile.icon
    messageText.textContent = tile.label
    speak(tile.speak)
    if (page !== 'home') {
      setTimeout(() => {
        if (mode === 'board') showPage('home')
      }, RETURN_HOME_MS)
    }
  }
}

function showWarning(message: string | null) {
  headWarning.hidden = message === null
  if (message) headWarning.textContent = message
}

function enterBoard() {
  welcome.hidden = true
  mode = 'board'
}

// ---- Calibration ----

async function calibrate() {
  mode = 'calibrating'
  welcome.hidden = true
  gazeDot.hidden = true
  headWarning.hidden = true
  showPage('home') // calibrate on the home page
  board.show(null, null, 0)
  try {
    // Full screen, so the board looks exactly as it will be used. The browser only
    // allows this right after a click, which is why calibration starts from a button.
    await document.documentElement.requestFullscreen().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 300)) // let the layout resize

    const result = await runCalibrationFlow(calibLayer, stream, board)
    xModel = result.xModel
    yModel = result.yModel
    headRef = result.headRef

    saveCalibration({
      xModel: xModel.toJSON(),
      yModel: yModel.toJSON(),
      headRef,
      hitRate: result.score.hitRate,
      savedAt: new Date().toISOString(),
    })
    showReport(result)
    messageIcon.textContent = ''
    messageText.textContent =
      result.score.hitRate >= 75
        ? 'Look at a word to say it'
        : 'Accuracy is low. Try more light on your face, then Recalibrate.'
    showPage('home')
    enterBoard()
  } catch (err) {
    mode = 'setup'
    welcome.hidden = false
    status.textContent = `Calibration failed: ${(err as Error).message}`
  }
}

calibrateBtn.addEventListener('click', calibrate)
recalibrateBtn.addEventListener('click', calibrate)
fullscreenBtn.addEventListener('click', () => document.documentElement.requestFullscreen().catch(() => {}))

function showReport({ candidates, score, xModel, yModel }: CalibrationResult) {
  accuracy.textContent = `Words hit ${Math.round(score.hitRate)}% of the time`

  const pct = (v: number) => `${Math.round(v)}%`
  const used = (yes: boolean) => (yes ? ' class="used"' : '')
  const rows = candidates
    .map(
      (c) => `<tr>
        <td>${c.set.name}</td>
        <td>${weightCount(c.set)}</td>
        <td${used(c.set === xModel.set)}>${c.cvErrX.toFixed(1)}%</td>
        <td${used(c.set === yModel.set)}>${c.cvErrY.toFixed(1)}%</td>
      </tr>`,
    )
    .join('')
  const perWord = Object.entries(score.hitByWord)
    .map(([id, hit]) => `${findTile(id)?.icon ?? id} ${pct(hit)}`)
    .join(' &nbsp; ')
  report.innerHTML = `<p><b>Word test</b> (${xModel.set.name}): ${pct(score.hitRate)} hit rate, jitter ${score.jitter.toFixed(1)}%</p>
  <p>Per word: ${perWord}</p>
  <table>
    <tr><th>Recipe</th><th>Weights</th><th>CV error ↔</th><th>CV error ↕</th></tr>
    ${rows}
  </table>
  <p class="muted">CV error = aim error on spots the recipe never trained on (% of screen).<br>
  Highlighted = used. Among near-equal recipes, the simplest wins.</p>`
}

main().catch((err) => {
  // If anything fails (e.g. camera permission denied), show it on screen instead of failing silently.
  status.textContent = `Error: ${err.message ?? err}`
  console.error(err)
})
