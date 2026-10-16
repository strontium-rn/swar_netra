# Swar Netra

**Speak with your eyes, using just a laptop webcam.**

A free eye-gaze communication board (AAC) for children who are non-verbal or minimally verbal, such as many autistic children. The child looks at a picture, like 🚽 *Toilet*, and the laptop says it out loud.

## Why

Eye-tracking AAC devices are expensive and need special hardware. Swar Netra aims to give the same ability to anyone with an ordinary laptop.

## Features

- **Eye tracking with a normal webcam:** a short calibration (follow a ⭐) learns how *your* eyes move.
- **Picture board:** one row of 6 big buttons (Help, Quick talk, Food & drink, Feelings, Activities, Body & needs). Look at one for about a second to say it.
- **Editable by parents and therapists:** **Edit words** lets you change text, emojis, photos and colors, and record your own voice.
- **Phone alerts:** the child's words reach the parents' Android phones. A parent taps **Coming**, and the laptop says "Mum is coming".
- **Works offline:** after the first visit, the board works without internet (phone alerts need it).
- **Private:** video never leaves the laptop. Phone alerts are end-to-end encrypted, so even our server can't read them.

⚠️ Early prototype: not yet tested with children, and not a medical device. Phone alerts can be delayed or missed; they support supervision, they don't replace it.

## How it works

```
webcam → face points (MediaPipe) → iris position → personal gaze model → which button? → speak
                                                                                └→ phone alert
```

## Run it

You need [Node.js](https://nodejs.org).

```bash
npm install
npm run build
npm run server      # app + phone alerts server on http://localhost:8787
```

Open http://localhost:8787 in Chrome and click **Start calibration**.

- **Develop:** `npm run dev` (http://localhost:5173), with `npm run server` running alongside for phone alerts.
- **Real phone:** phones need HTTPS for notifications. For a quick test, run `cloudflared tunnel --url http://localhost:8787` and open the `https://…` address it prints on the laptop.

**Tips:** light on your face (not behind you), sit an arm's length from the screen, and keep your head still during calibration.

## Code map

| Where | What |
|---|---|
| `src/main.ts` | Starts the app and connects the parts |
| `src/camera.ts`, `landmarks.ts`, `eyeFeatures.ts` | Webcam → face points → eye measurements |
| `src/calibration*.ts`, `gazeModel.ts`, `evaluate.ts`, `columnFix.ts` | Calibration, the gaze model, and its accuracy checks |
| `src/smoothing.ts`, `driftTracker.ts`, `headGuard.ts`, `signalQuality.ts` | Steadier gaze, drift correction, head and lighting checks |
| `src/board.ts`, `dwell.ts`, `speech.ts` | Buttons, "look to select", speaking |
| `src/vocabulary.ts`, `editor.ts`, `storage.ts`, `media.ts`, `trimAudio.ts` | Words, the editor, saving, photos and voice recordings |
| `src/alerts*.ts`, `secureChannel.ts`, `src/phone/`, `phone.html` | Phone alerts: laptop side, encryption, parents' phone app |
| `server/` | Relay server: pairing, push notifications, replies |
| `public/sw.js`, `public/phone-sw.js` | Offline support, and phone notifications |
