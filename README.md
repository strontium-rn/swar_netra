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

## Current stage: early prototype

**Working now**
- Webcam eye tracking with per-person calibration and an automatic quality check
- Category board: Help, Quick talk, Food & drink, Feelings, Activities, Body & needs
- Dwell to select (look ~1 s), spoken output, head-position warning
- Quick fix (3 looks) and automatic drift correction, saved calibration
- Works offline after the first visit (installable app)

**In progress**
- Making calibration more reliable across people, lighting and glasses

**Next**
- Caregiver editing: custom words, pictures and recorded voices
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

**Tips:** light on your face (not behind you), sit about an arm's length from the screen, and keep your head still during calibration.
