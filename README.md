# Swar Netra

**Speak with your eyes, using just a laptop webcam.**

Swar Netra is a free eye-gaze communication board (AAC, Augmentative and Alternative Communication) for children who are non-verbal or minimally verbal, such as many autistic children. The child looks at a picture, like 🚽 *Toilet* or 😊 *Happy*, and the computer says it out loud.

## Why

Eye-tracking AAC devices exist, but they are expensive and need special hardware, so most families and many therapy centers can't get one. Swar Netra aims to give the same ability to anyone with an ordinary laptop and a browser.

## Vision

- **No special hardware:** works with a normal webcam.
- **Private:** all processing happens on the device. No video ever leaves the computer.
- **Built for children:** big picture buttons, fixed positions to build motor memory, and simple calibration.
- **Personal:** caregivers can change the words and pictures, and record their own voice so speech sounds familiar.
- **Reliable anywhere:** works offline, so it never fails when the Wi-Fi does.

## How it works

```
webcam → face landmarks (MediaPipe) → iris position → personal gaze model
       → smoothing → which button? → look ~1 second → speak
```

A short calibration (follow a ⭐ with your eyes) teaches the app how *your* eyes move. The board uses one row of tall buttons, because webcam tracking is much better at left/right than at up/down.

## Changing the words (for parents and therapists)

Click **Edit words** (on the welcome screen, or in the panel at the top of the board). You see each page laid out exactly like the board. Click a button to:

- change its text, and what is said out loud
- use an emoji, or a photo (e.g. the child's own cup)
- record your own voice for it (otherwise the computer voice speaks)
- change a group's color, move a word left or right, add or remove words

Nothing changes on the board until you click **Save**. **Help** and **Back** always stay in the same place.

Tip: children learn *where* each word is, so their eyes go there without searching. Change words when needed, but move them rarely.

Everything (words, photos, recordings) is saved in this browser on this computer only. Clearing the browser's site data removes it.

## Current stage: early prototype

**Working now**
- Webcam eye tracking with per-person calibration and an automatic quality check
- Category board: Help, Quick talk, Food & drink, Feelings, Activities, Body & needs
- Dwell to select (look ~1 s), spoken output, head-position warning
- Quick fix (3 looks) and automatic drift correction, saved calibration
- Works offline after the first visit (installable app)
- Caregiver editing: change words, emojis, colors and positions, add photos, and record your own voice (all saved on this computer only)

**In progress**
- Making calibration more reliable across people, lighting and glasses

**Next**
- Backup and share a word set as a file (e.g. a therapist sets it up, the family loads it)
- More vocabulary, such as people and a keyboard for children who can read

⚠️ This is a prototype and has not been tested with children yet. It is not a medical device.

## Run it locally

You need [Node.js](https://nodejs.org) installed.

```bash
npm install
npm run dev
```

Open http://localhost:5173 in Chrome, allow the camera, and click **Start calibration**.

To try the offline version (what users get when it's hosted):

```bash
npm run build
npm run preview
```

Open http://localhost:4173 once, and after that it also starts without internet.

## Code map

All code is in `src/`. Each file does one job:

| File | Job |
|---|---|
| `main.ts` | Starts the app and connects all the parts |
| `camera.ts`, `landmarks.ts` | Webcam, and finding face points (MediaPipe) |
| `eyeFeatures.ts` | Turns face points into eye measurements |
| `calibration.ts`, `calibrationFlow.ts` | The ⭐ calibration and word test |
| `gazeModel.ts`, `evaluate.ts` | Learns where you look, and scores how well |
| `smoothing.ts`, `driftTracker.ts` | Steadies the gaze, and corrects slow drift |
| `headGuard.ts`, `signalQuality.ts` | Head-position and lighting checks |
| `board.ts`, `dwell.ts` | Draws the buttons; "look ~1 s to select" |
| `vocabulary.ts` | The words (and the starting set) |
| `editor.ts` | The word editor for caregivers |
| `storage.ts`, `media.ts` | Saving: words and calibration (localStorage), photos and recordings (IndexedDB) |
| `speech.ts` | Speaks: your recording, or the computer voice |
| `offline.ts`, `public/sw.js` | Offline support |

**Tips:** light on your face (not behind you), sit about an arm's length from the screen, and keep your head still during calibration.
