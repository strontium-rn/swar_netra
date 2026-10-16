// Entry point: wires the pipeline modules together and runs the main loop.
// It does no real work itself. Each module does one job; main.ts connects them.
//
//   camera → landmarks → eye features → gaze model → smoothing → board hit-test → dwell → speech

import './style.css'
import { startCamera } from './camera.ts'
import { LandmarkDetector, type FaceFrame } from './landmarks.ts'
import { drawHeadGuide, drawPoints } from './debugView.ts'
import { computeEyeFeatures } from './eyeFeatures.ts'
import { runCalibrationFlow, runQuickFix, type CalibrationResult } from './calibrationFlow.ts'
import { GazeModel, weightCount } from './gazeModel.ts'
import { GazeSmoother } from './smoothing.ts'
import { FrameStream } from './frameStream.ts'
import { driftMessage, headPose, type HeadPose } from './headGuard.ts'
import { Board } from './board.ts'
import { DwellSelector } from './dwell.ts'
import { DriftTracker } from './driftTracker.ts'
import { speak } from './speech.ts'
import { findTile, mediaIds, pageTiles, tileColor, useVocabulary, vocabulary, type PageId } from './vocabulary.ts'
import { loadCalibration, loadVocabulary, saveCalibration } from './storage.ts'
import { getMedia, loadMedia, mediaUrl, replaceMedia } from './media.ts'
import { trimSilence } from './trimAudio.ts'
import { iconElement } from './board.ts'
import { openEditor } from './editor.ts'
import { enableOffline } from './offline.ts'
import { NoiseMeter, SIGNAL_ADVICE, signalLevel } from './signalQuality.ts'

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const video = $<HTMLVideoElement>('#video')
const overlay = $<HTMLCanvasElement>('#overlay')
const welcome = $<HTMLDivElement>('#welcome')
const status = $<HTMLParagraphElement>('#status')
const calibrateBtn = $<HTMLButtonElement>('#calibrate')
const recalibrateBtn = $<HTMLButtonElement>('#recalibrate')
const quickFixBtn = $<HTMLButtonElement>('#quickfix')
const saveDataBtn = $<HTMLButtonElement>('#save-data')
const driftInfo = $<HTMLSpanElement>('#drift-info')
const signalInfo = $<HTMLSpanElement>('#signal-info')
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
const editorEl = $<HTMLDivElement>('#editor')

// ---- App state ----
// The app is always in exactly one mode. Writing it down explicitly (a "state machine")
// avoids bugs like the board reacting to your eyes while you're calibrating.
//   setup → calibrating → board  (and board → calibrating again on "Recalibrate")
//   editing: the caregiver is changing words; the eyes select nothing meanwhile.
let mode: 'setup' | 'calibrating' | 'board' | 'editing' = 'setup'
let xModel: GazeModel | null = null // predicts left/right (decides the word)
let yModel: GazeModel | null = null // predicts up/down (only used for the gaze dot)
let headRef: HeadPose | null = null // head position during calibration
let lastFaceMs = -Infinity // when a face was last seen
let lastResult: CalibrationResult | null = null // this session's calibration, for "Save data"
let savedHitRate = 0

const stream = new FrameStream()
const smoother = new GazeSmoother()
const dwell = new DwellSelector()
const drift = new DriftTracker()
const noiseMeter = new NoiseMeter()
const board = new Board($<HTMLElement>('#words'))
let centers: number[] = [] // x of each button center, for the drift tracker
const updateCenters = () => (centers = board.centers().map((c) => c.x))
window.addEventListener('resize', updateCenters)

// Show a page of the board. The button that lands under the gaze is locked until
// the user looks away, so a page change never selects something by accident.
function showPage(next: PageId) {
  const tiles = pageTiles(next).map(
    (t) =>
      t && {
        id: t.id,
        label: t.label,
        icon: t.icon,
        picture: t.kind === 'back' ? undefined : mediaUrl(t.picture),
        color: tileColor(t, next),
        preview:
          t.kind === 'category'
            ? t.words.flatMap((w) => (w ? [{ icon: w.icon, picture: mediaUrl(w.picture), label: w.label }] : []))
            : undefined,
      },
  )
  dwell.reset(board.setPage(tiles))
  updateCenters()
  const category = next === 'home' ? null : findTile(next)
  pageTitle.textContent = category ? `${category.icon} ${category.label}` : ''
}
useVocabulary(loadVocabulary())
showPage('home')

async function main() {
  // Photos and recordings load from the browser's database (fast, but not instant),
  // then the page is drawn again with them.
  await loadMedia(mediaIds(vocabulary()))
  await trimOldRecordings()
  showPage('home')

  status.textContent = 'Starting camera…'
  await startCamera(video)

  // Make the canvas the same pixel size as the video so points line up.
  overlay.width = video.videoWidth
  overlay.height = video.videoHeight
  const aspect = video.videoWidth / video.videoHeight

  status.textContent = 'Preparing offline mode…'
  await enableOffline()

  status.textContent = 'Loading face model…'
  const detector = await LandmarkDetector.create()

  // A saved calibration means we can skip straight to the board.
  const saved = loadCalibration()
  if (saved) {
    try {
      xModel = GazeModel.fromJSON(saved.xModel)
      yModel = GazeModel.fromJSON(saved.yModel)
      headRef = saved.headRef
      savedHitRate = saved.hitRate
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

// Recordings made before silence trimming existed still start with a pause: trim them once.
// (Trimmed recordings are saved as WAV, so the format tells us which ones are already done.)
async function trimOldRecordings() {
  const v = vocabulary()
  const ids = [v.help, ...v.categories.flatMap((c) => c.words)].flatMap((w) => (w?.audio ? [w.audio] : []))
  for (const id of ids) {
    const blob = await getMedia(id).catch(() => undefined)
    if (!blob || blob.type === 'audio/wav') continue
    try {
      await replaceMedia(id, await trimSilence(blob))
    } catch {
      // can't decode it: keep the original, it still plays
    }
  }
}

// Everything that happens for one camera frame.
function onFrame(frame: FaceFrame | null, now: number, dt: number, aspect: number) {
  if (frame) lastFaceMs = now
  if (!frame) noiseMeter.gap()
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
  noiseMeter.push(features.irisX, now)
  showSignal()
  const pose = headPose(frame, aspect)
  stream.publish({ features, pose, aspect })

  const headOff = headRef ? driftMessage(headRef, pose, aspect) : null
  drawPoints(overlay, frame.points)
  drawHeadGuide(overlay, headRef, pose, headOff === null)

  if (mode !== 'board' || !xModel || !yModel) return

  // Gaze → smoothing → position on screen (as fractions, clamped to 0..1).
  let gaze = { x: xModel.predict(features).x, y: yModel.predict(features).y }
  if (smoothToggle.checked) gaze = smoother.smooth(gaze, dt)
  // Drift correction: shift by what the tracker has learned, then let it learn from this frame
  // (only while the head is in position, so it doesn't learn from bad data).
  gaze.x = drift.correct(gaze.x)
  if (!headOff) drift.observe(gaze.x, now, centers)
  showDriftCorrection()
  const x = Math.min(1, Math.max(0, gaze.x))
  const y = Math.min(1, Math.max(0, gaze.y))
  gazeDot.style.transform = `translate(${x * window.innerWidth}px, ${y * window.innerHeight}px)`
  gazeDot.hidden = !showDotToggle.checked
  gazeDot.classList.toggle('paused', headOff !== null)

  showWarning(headOff)
  // Fail-safe: if the head is out of position, the gaze can't be trusted, so select nothing.
  updateBoard(headOff ? null : board.wordAt(x, now), now)
}

// Before calibrating, make sure the camera can see the face. Starting without a face
// would only produce a bad calibration, so the button stays disabled until then.
// It also checks the eye signal: calibrating in poor conditions gives a poor board, and
// no amount of clever math afterwards can fix data the camera couldn't see clearly.
// (Only a warning, not a block: the caregiver may have no better light available.)
function updateFaceCheck(now: number) {
  const faceOk = now - lastFaceMs < 500
  calibrateBtn.disabled = !faceOk
  const noise = noiseMeter.noise()
  const level = noise === null ? null : signalLevel(noise)
  status.textContent = !faceOk
    ? 'Looking for your face… Make sure it is well lit and in the middle of the camera.'
    : level === 'poor'
      ? `⚠ Face found, but the camera can't see your eyes clearly. ${SIGNAL_ADVICE}`
      : '✓ Face found. Sit comfortably about an arm’s length from the screen.'
  status.classList.toggle('ok', faceOk && level !== 'poor')
}

// Live eye-signal quality for the caregiver panel.
let shownSignal = ''
function showSignal() {
  const noise = noiseMeter.noise()
  const text = noise === null ? '…' : signalLevel(noise)
  if (text !== shownSignal) signalInfo.textContent = shownSignal = text
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
    messageIcon.replaceChildren(iconElement(tile.icon, mediaUrl(tile.picture), 'message-photo'))
    messageText.textContent = tile.label
    speak(tile.speak, mediaUrl(tile.audio))
    // Stay on this page: only the user decides when to go back (via the Back button).
  }
}

function showWarning(message: string | null) {
  headWarning.hidden = message === null
  if (message) headWarning.textContent = message
}

// Show the caregiver how much the drift tracker is currently correcting.
let shownCorrection = ''
function showDriftCorrection() {
  const c = drift.current * 100
  const text = Math.abs(c) < 0.5 ? 'none' : `${c < 0 ? '←' : '→'} ${Math.abs(c).toFixed(1)}%`
  if (text !== shownCorrection) driftInfo.textContent = shownCorrection = text
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
    lastResult = result
    drift.reset()
    savedHitRate = result.score.hitRate
    persist()
    showReport(result)
    saveDataBtn.hidden = false
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

function persist() {
  if (!xModel || !yModel || !headRef) return
  saveCalibration({
    xModel: xModel.toJSON(),
    yModel: yModel.toJSON(),
    headRef,
    hitRate: savedHitRate,
    savedAt: new Date().toISOString(),
  })
}

// Quick fix: 3 looks to correct small drift, instead of a full recalibration.
async function quickFix() {
  if (!xModel || !yModel) return calibrate() // nothing to fix yet
  mode = 'calibrating'
  gazeDot.hidden = true
  headWarning.hidden = true
  showPage('home')
  board.show(null, null, 0)
  try {
    const fixed = await runQuickFix(calibLayer, stream, board, xModel, yModel)
    xModel = fixed.xModel
    yModel = fixed.yModel
    headRef = fixed.headRef
    drift.reset()
    persist()
    messageIcon.textContent = ''
    messageText.textContent = 'Fixed. Look at a word to say it'
  } catch (err) {
    messageText.textContent = `Quick fix failed: ${(err as Error).message}`
  }
  enterBoard()
}

// Download the raw calibration data as a file. It's only numbers (eye measurements and
// star positions), no video or images, so it can be shared to diagnose problems.
function saveData() {
  if (!lastResult) return
  const { recordings, candidates, score, xModel: xm, yModel: ym } = lastResult
  const data = {
    app: 'swar-netra',
    savedAt: new Date().toISOString(),
    screen: { width: window.innerWidth, height: window.innerHeight },
    columns: board.centers(),
    chosen: { x: xm.set.name, y: ym.set.name },
    noise: lastResult.noise,
    candidates: candidates.map((c) => ({ name: c.set.name, cvErrX: c.cvErrX, cvErrY: c.cvErrY, testHit: c.test.hitRate, testErrX: c.testErrX })),
    score,
    headRef,
    recordings,
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `swar-netra-calibration-${data.savedAt.slice(0, 19).replace(/:/g, '-')}.json`
  a.click()
  URL.revokeObjectURL(url)
}

// ---- Word editor ----

async function editWords() {
  if (mode === 'calibrating' || mode === 'editing') return
  const before = mode
  mode = 'editing'
  gazeDot.hidden = true
  headWarning.hidden = true
  const edited = await openEditor(editorEl, vocabulary())
  if (edited) {
    useVocabulary(edited)
    messageIcon.textContent = ''
    messageText.textContent = 'Look at a word to say it'
  }
  await loadMedia(mediaIds(vocabulary())) // also deletes photos/recordings no longer used
  showPage('home')
  mode = before
}

calibrateBtn.addEventListener('click', calibrate)
$('#edit-words').addEventListener('click', editWords)
$('#welcome-edit').addEventListener('click', editWords)
quickFixBtn.addEventListener('click', quickFix)
saveDataBtn.addEventListener('click', saveData)
recalibrateBtn.addEventListener('click', calibrate)
fullscreenBtn.addEventListener('click', () => document.documentElement.requestFullscreen().catch(() => {}))

// Caregiver-typed text must never be read as HTML code (see board.ts).
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function showReport({ candidates, score, xModel, yModel, noise }: CalibrationResult) {
  accuracy.textContent = `Words hit ${Math.round(score.hitRate)}% of the time`

  const pct = (v: number) => `${Math.round(v)}%`
  const used = (yes: boolean) => (yes ? ' class="used"' : '')
  const rows = candidates
    .map(
      (c) => `<tr>
        <td>${c.set.name}</td>
        <td>${weightCount(c.set)}</td>
        <td${used(c.set === xModel.set)}>${pct(c.test.hitRate)} (${pct(c.test.stressHit)})</td>
        <td${used(c.set === xModel.set)}>${c.testErrX.toFixed(1)}%</td>
        <td${used(c.set === xModel.set)}>${c.cvErrX.toFixed(1)}%</td>
        <td${used(c.set === yModel.set)}>${c.cvErrY.toFixed(1)}%</td>
      </tr>`,
    )
    .join('')
  // Bias: which way the estimate leans on each button (← left, → right), if noticeably.
  const lean = (b: number | undefined) => (b === undefined || Math.abs(b) < 1 ? '' : ` ${b < 0 ? '←' : '→'}${Math.abs(b).toFixed(1)}%`)
  const perWord = Object.entries(score.hitByWord)
    .map(([id, hit]) => `${escapeHtml(findTile(id)?.icon ?? id)} ${pct(hit)}${lean(score.biasByWord[id])}`)
    .join(' &nbsp; ')
  const level = signalLevel(noise)
  report.innerHTML = `<p><b>Eye signal during calibration:</b> ${level} (noise ${(noise * 10000).toFixed(1)}; good is under 3)${
    level === 'poor' ? `<br>⚠ ${SIGNAL_ADVICE} Then recalibrate.` : ''
  }</p>
  <p><b>Word test</b> (${xModel.set.name}): ${pct(score.hitRate)} hit rate, ${pct(score.stressHit)} under stress, jitter ${score.jitter.toFixed(1)}%</p>
  <p>Per word: ${perWord}</p>
  <table>
    <tr><th>Recipe</th><th>Weights</th><th>Test hits (stress)</th><th>Test error ↔</th><th>CV error ↔</th><th>CV error ↕</th></tr>
    ${rows}
  </table>
  <p class="muted">← / → = which way the estimate leans on that button.<br>
  CV error = RMS aim error on spots the recipe never trained on (% of screen).<br>
  Test = the word test (one look at each button, edges included).<br>
  Stress = test hits if the estimate drifted 3% left or right: the safety margin.<br>
  Left/right recipe: best stress score first, then lowest average of test + CV error; simplest if close.</p>`
}

main().catch((err) => {
  // If anything fails (e.g. camera permission denied), show it on screen instead of failing silently.
  status.textContent = `Error: ${err.message ?? err}`
  console.error(err)
})
