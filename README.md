# Swar Netra

**Speak with your eyes, using just a laptop webcam.**

A free eye-gaze communication board (AAC) for children who are non-verbal or minimally verbal, such as many autistic children. The child looks at a picture, like 🚽 *Toilet*, and the laptop says it out loud.

## Why

Eye-tracking AAC devices are expensive and need special hardware. Swar Netra aims to give the same ability to anyone with an ordinary laptop.

## Features

- **Eye tracking with a normal webcam:** a short calibration (follow a ⭐) learns how *your* eyes move.
- **Picture board:** one row of 6 big buttons (Help, Quick talk, Food & drink, Feelings, Activities, Body & needs). Look at one for about a second to say it.
- **Editable by parents and therapists:** **Edit words** lets you change text, emojis, photos and colors, and record your own voice.
- **Phone alerts:** the child's words reach the parents' Android phones, grouped into one notification when several are picked in a row (Help goes out at once). A parent taps **Coming**, and the laptop says "Mum is coming".
- **Works offline:** after the first visit, the board works without internet (phone alerts need it).
- **Private:** video never leaves the laptop. Phone alerts are end-to-end encrypted, so even our server can't read them.
- **User study (opt-in):** testers who agree send their calibration results and a feedback form, under a random ID. They can delete it any time.

⚠️ Early prototype: not yet tested with children, and not a medical device. Phone alerts can be delayed or missed; they support supervision, they don't replace it.

## How it works

```
webcam → face points (MediaPipe) → iris position → personal gaze model → which button? → speak
                                                                                └→ phone alert
```

## Run it

You need [Node.js](https://nodejs.org) 22.6 or newer.

```bash
npm install
npm run build
npm run server      # app + phone alerts server on http://localhost:8787
```

Open http://localhost:8787 in Chrome and click **Start calibration**.

- **Develop:** `npm run dev` (http://localhost:5173), with `npm run server` running alongside for phone alerts.
- **Check your changes:** `npm run typecheck` finds type mistakes in the app and the server.
- **Real phone:** phones need HTTPS for notifications. For a quick test, install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), run `npm run tunnel` and open the `https://…` address it prints on the laptop (not localhost: a phone can't reach that). (It avoids IPv6, which doesn't work on some networks.)

- **Online (Render + Neon, free):** create a free Postgres database on [Neon](https://neon.tech) and copy its connection string. On [Render](https://render.com), choose **New → Blueprint**, pick this repo, and paste the string as `DATABASE_URL`. Render builds and runs it from `render.yaml` and redeploys on every push.
- **Study data:** download it from `/api/study/export?format=csv&token=…`, using the `ADMIN_TOKEN` shown in Render's Environment tab.

**Tips:** light on your face (not behind you), sit an arm's length from the screen, and keep your head still during calibration.

**Privacy:** saved calibration data files contain your eye measurements. Keep them to yourself and never commit them (the `calibiration data/` folder is already ignored by git).

## If something doesn't work

- **No camera picture:** allow camera access in the browser (the icon at the left of the address bar), and close other apps using the webcam.
- **Buttons get picked wrongly:** recalibrate with the light in front of you and your head still.
- **No sound:** check the volume, and click once anywhere on the page (browsers block sound until you do).
- **No phone notifications:** the phone must open the page over HTTPS, and notifications must be allowed for it in Chrome.

## Next ideas

- Test phone alerts on a real Android phone, and host the relay server online
- Back up or share a word set as a file
- More words: people, and a simple keyboard
- If nobody answers an urgent alert, alert a second caregiver

Full write-up: [docs/PROJECT_REPORT.md](docs/PROJECT_REPORT.md).

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
| `src/study.ts`, `studyPanel.ts` | User study: consent screen, feedback form |
| `server/` | Relay server: pairing, push notifications, replies, study records |
| `public/sw.js`, `public/phone-sw.js` | Offline support, and phone notifications |
