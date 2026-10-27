# Swar Netra: Project Report

**An eye-gaze communication board that works with an ordinary laptop webcam**

| | |
|---|---|
| Author | Aarya |
| Repository | https://github.com/strontium-rn/swar_netra |
| Period covered | 12 October 2026 to 27 October 2026 |
| Status | Working prototype, about to start a first user study with adult testers |

---

## Abstract

Many children who are non-verbal or minimally verbal, including many autistic children, can communicate with
**augmentative and alternative communication (AAC)**: pointing at pictures that a device speaks out loud. Children
who cannot point reliably can select pictures with their **eyes**, but dedicated eye-tracking AAC devices need special
infrared hardware and are expensive.

Swar Netra ("voice of the eyes") is a free web app that does this with the webcam already built into a laptop. A
face-tracking model (MediaPipe Face Landmarker) finds the eyes in each camera frame, a short calibration learns a
personal model that turns iris position into a screen position, and the child selects one of six large picture
buttons by looking at it for about a second. The laptop then speaks the word, and can also send it to the parents'
phones as an end-to-end encrypted notification, to which a parent can reply "Coming".

In five recorded calibration sessions by the developer, the selected model chose the right button in
**92–100 %** of test looks, and **100 %** in all four sessions with good light. A per-button correction added in
this period raised the share of time the estimate sat on the correct button from 96.6–100 % to 100 % when replayed
on the daylight sessions. The main open questions are how well this works for other people, other laptops and other
rooms, and eventually for children; the deployment and consent-based user study described in Section 12 are built to
answer the first part of that.

---

## 1. Introduction

### 1.1 The problem

Speech is not available to everyone. A sizeable share of autistic children remain minimally verbal into school age
(often cited as roughly a quarter to a third [1]), and children with conditions such as cerebral palsy may
understand language well but be unable to speak or point precisely. Picture-based AAC lets them say what they need:
"toilet", "hungry", "it hurts", "help".

For children who cannot point reliably, **eye gaze** is often the most dependable way to select. Commercial
eye-gaze systems work well, but they rely on dedicated infrared eye-trackers and specialised devices, which puts them
out of reach for many families, especially in lower-income countries.

### 1.2 The idea

Almost every laptop already has a camera. If the eyes can be tracked well enough with that camera alone to tell
apart a handful of **large** buttons, a free website could provide a basic eye-gaze communication board to anyone with
a laptop. Swar Netra deliberately trades the fine precision of infrared trackers (which can select small keys) for
**zero cost**: it only needs to distinguish six big buttons in one row.

### 1.3 Objectives

1. Select one of six on-screen buttons reliably with the eyes, using only a built-in webcam.
2. Make calibration short, understandable and self-checking, so a caregiver knows whether it worked.
3. Let parents and therapists adapt the words, pictures and voice to the child.
4. Let the child reach a parent who is in another room (phone alerts), without exposing what the child says.
5. Respect privacy: video never leaves the laptop.
6. Work offline once loaded, and run in a normal browser with nothing to install.

### 1.4 Scope of this report

This report describes the system as built, the design decisions and the reasons behind them, the evidence collected
so far, its limitations, and the plan for the first user study. It is written for readers who want to understand or
continue the work.

---

## 2. Background

**AAC and core vocabulary.** AAC boards usually combine a few "core" words that are useful everywhere (yes, no, more,
stop, help) with topic pages (food, feelings, body). Swar Netra follows this with a home page of categories and a
fixed Help button.

**Dwell selection.** With eye gaze there is no "click". The usual approach is *dwell*: looking at a target for a set
time selects it. Too short a dwell causes accidental selections (the "Midas touch" problem); too long is tiring.

**Webcam gaze estimation.** Research tools such as WebGazer [2] showed that gaze can be estimated in the browser
from a webcam by learning a mapping from eye appearance to screen position during calibration. Accuracy is far
lower than infrared trackers, typically several degrees, so interfaces must use large targets.

**Face landmark models.** Google's MediaPipe Face Landmarker [3] returns 478 face points per frame, including five
points on each iris, plus "blendshape" scores such as *eyeLookInLeft*. It runs in the browser with WebAssembly and the
GPU, fast enough for real-time use on an ordinary laptop.

**Smoothing.** Gaze estimates from a webcam are jittery. The One Euro Filter [4] is a standard adaptive low-pass
filter that smooths heavily when the signal is still and lightly when it moves fast, giving low jitter without much lag.

---

## 3. Requirements

| Type | Requirement | How it is met |
|---|---|---|
| Functional | Select a word by looking at it, and hear it spoken | Dwell selection (1.2 s) + Web Speech API or a recorded voice |
| Functional | Calibrate for each user and report how well it worked | Calibration flow with a word test, stress test and report (Section 5) |
| Functional | Caregivers can change words, pictures and voice | Word editor (Section 6) |
| Functional | Reach a parent who is not in the room | Phone alerts with replies (Section 7) |
| Non-functional | No special hardware, no cost | Built-in webcam, runs in Chrome/Brave/Edge |
| Non-functional | Privacy | Video processed locally; alerts end-to-end encrypted; study data opt-in and anonymous |
| Non-functional | Works offline | Service worker caches the app and the face model |
| Non-functional | Robust in real rooms | Signal-quality check, head-position guard, drift correction, quick fix |
| Non-functional | Understandable by non-technical caregivers | Plain-language messages, one-click recalibration, quality gate |

---

## 4. System architecture

### 4.1 Overview

```
 ┌───────────────────────── Laptop browser (the child's board) ─────────────────────────┐
 │ webcam → MediaPipe face points → eye features → gaze model → smoothing → which button? │
 │                                                                       │               │
 │                                                     dwell 1.2 s → speak the word      │
 │                                                                       └─ phone alert ─┼──┐
 └───────────────────────────────────────────────────────────────────────────────────────┘  │
                                                                                            │ sealed (AES-GCM)
 ┌──────────── Relay server (Node.js, hosted on Render) ────────────┐                       │
 │ pairing · forwarding · urgent repeats · replies · study records  │◀──────────────────────┘
 │ storage: Postgres (Neon) online, JSON files on a laptop          │
 └──────────────────────────────┬───────────────────────────────────┘
                                │ Web Push (via Google FCM)
                                ▼
                 ┌──── Parent's Android phone (web app) ────┐
                 │ notification: "🆘 Help"  [Coming] [5 min] │
                 └───────────────────────────────────────────┘
```

All gaze processing happens **in the laptop's browser**. The server never receives video, images or eye data, except
the calibration *summary numbers* from study testers who agreed (Section 12).

### 4.2 Technology choices

| Choice | Why |
|---|---|
| TypeScript, no UI framework | Small app; types catch mistakes; plain DOM keeps the code easy to follow |
| Vite | Fast development server and production build of two pages (board and phone app) |
| MediaPipe Face Landmarker (WASM + GPU) | Accurate iris points in real time in the browser; files are self-hosted for offline use |
| Plain Node.js `http` server | Few routes; no framework needed; runs TypeScript directly with `--experimental-strip-types` |
| `web-push` library | Standard implementation of Web Push with VAPID signatures |
| Postgres (Neon) / JSON files | Hosted servers lose their disk on restart, so data online lives in a database; files keep local use simple |
| WebCrypto AES-GCM | Built into every browser; authenticated encryption for alerts |
| Render (free tier) | Deploys from GitHub on every push, HTTPS included, no credit card |

### 4.3 Code map

| Area | Files |
|---|---|
| App start and wiring | `src/main.ts` |
| Camera and face points | `src/camera.ts`, `src/landmarks.ts`, `src/frameStream.ts` |
| Eye features and head pose | `src/eyeFeatures.ts`, `src/headGuard.ts`, `src/signalQuality.ts` |
| Calibration and models | `src/calibration.ts`, `src/calibrationFlow.ts`, `src/gazeModel.ts`, `src/evaluate.ts`, `src/columnFix.ts` |
| Live gaze | `src/smoothing.ts`, `src/driftTracker.ts`, `src/dwell.ts` |
| Board and words | `src/board.ts`, `src/vocabulary.ts`, `src/speech.ts`, `src/editor.ts`, `src/media.ts`, `src/trimAudio.ts`, `src/storage.ts` |
| Phone alerts | `src/alerts.ts`, `src/alertsPanel.ts`, `src/secureChannel.ts`, `src/phone/`, `public/phone-sw.js`, `server/` |
| User study | `src/study.ts`, `src/studyPanel.ts`, server routes in `server/server.ts`, storage in `server/store.ts` |
| Offline | `public/sw.js`, `src/offline.ts`, `scripts/copy-mediapipe.mjs` |
| Deployment | `render.yaml` |

---

## 5. Gaze estimation

### 5.1 Eye features

For each camera frame (about 27 per second on the test laptop), `eyeFeatures.ts` turns MediaPipe's face points into
seven numbers:

| Feature | Meaning |
|---|---|
| `irisX`, `irisY` | Where the iris centre sits between the eye corners and lids, divided by eye width (so distance to the screen matters less) |
| `open` | How open the eyelids are (lids follow the eye up and down) |
| `lookH`, `lookV` | MediaPipe's blendshape estimate of looking left/right and up/down |
| `yaw`, `pitch` | Head rotation, from the nose tip relative to the outer eye corners |

Both eyes are averaged, which reduces noise.

### 5.2 Calibration protocol

A star moves across the screen and the user follows it with their eyes only:

1. **Head reference.** The head position is measured first. If the head turns more than about 4° or slides during
   calibration, recording pauses until it is back (`headGuard.ts`).
2. **Sweep.** The star visits 13 spots in random order: each button centre, the gaps between buttons and both
   edges, alternating between 30 % and 70 % of the button height. Random order prevents the model from learning
   "time" instead of "position".
3. **Recording each spot.** The star glides there (600 ms, ease-in-out), the eyes are given 200 ms to land, then
   1.6 s are recorded and the **steadiest 800 ms window** is kept. This automatically skips blinks and glances, and
   adapts to slow and fast lookers. Spots that are much shakier than the rest are redone.
4. **Word test.** One more look at the centre of each button. These looks are *not* used for training at first;
   they are the exam.

### 5.3 The model and how a recipe is chosen

The horizontal position is predicted by a small linear model over a chosen set of features ("recipe"), fitted by
**ridge-regularised least squares** (normal equations, λ = 0.01). Seven recipes are tried, from 2 to 11 weights,
for example:

- *Iris ↔ only*: x = a + b·irisX
- *Iris ↔ S-curve*: x = a + b·irisX + c·irisX³ (the eye is a rotating ball, so the iris moves a little less per
  centimetre near both edges: a symmetric S-shape)
- *Eye-look ↔ S-curve*, *Iris + eye-look*, *Iris + head turn*, *Iris 2D*, and a combined recipe.

Each recipe is scored two ways:

- **Cross-validation** on the sweep: train without one spot, predict it, repeat.
- **Word test**: train on the sweep, then check the held-out button looks, through the same smoother the live board
  uses. Two numbers come out: the **hit rate** (share of frames on the right button) and the **stress hit rate**
  (hit rate when every estimate is pushed 3 % of the screen left *and* right, a safety margin).

The recipe with the best stress hit rate wins (within 2 points); ties go to the lowest average error, and a simpler
recipe is preferred if it is within 0.5 % of screen width. Choosing on the word test, not only on cross-validation, was
a deliberate change: cross-validation only tests spots *between* other spots, so a straight-line model that misses
the edge buttons could still look good there.

The vertical position only moves the optional gaze dot (the board is one row), so it uses the recipe with the lowest
vertical cross-validation error.

### 5.4 Quality gate

Any button below **70 %** hit rate in the word test counts as weak. The app names the weak buttons and offers to redo
them. If the eye signal is noisy (Section 5.8), it says that more light, not more practice, is needed. A redo adds two
extra training looks at each weak button (30 % and 70 % height), records a fresh test look, and re-runs the whole
recipe choice. At most two redo rounds are offered. Finally, the chosen recipe is retrained on **all** looks.

### 5.5 Per-button correction ("column fix")

Analysis of the recorded sessions showed that most of the remaining error was **systematic per button** (2.6–3.5 % of
screen width) rather than random from look to look (1.3–2.2 %): in a given session some buttons consistently read a
little left, others a little right. A smooth curve cannot bend separately for each button, so after the final model
is fitted, `columnFix.ts` measures the average lean at each button centre and shifts that button's area back by
**80 %** of it (capped at 6 % of the screen), blending linearly between neighbouring buttons. Only 80 % is corrected
because each measurement also contains random error; 70–100 % worked best in testing. The fix is switched off when the
eye signal is poor, because in a dim session it made results worse.

### 5.6 Live gaze: smoothing, dwell, drift

- **Smoothing:** One Euro Filter (min cutoff 0.4, β = 2.0), applied in screen units.
- **Dwell:** each button has a "bucket" that fills while it is looked at and empties at 60 % of that speed when not.
  A full bucket (1.2 s) selects. After a selection, the same word cannot fire again until the eyes have left it for
  400 ms. Draining slowly, instead of resetting, makes selection forgiving of brief flickers to a neighbour.
- **Drift tracker:** over minutes the head settles differently and the estimate slides sideways. When the gaze rests
  for 400 ms close to a button centre, the small gap is assumed to be drift and 5 % of it is corrected, capped at 8 %
  of the screen. Many small nudges average out the real drift while random errors cancel.
- **Quick fix:** three looks that re-centre the model without a full calibration.

### 5.7 Head position

A guide on the camera preview shows where the head was during calibration. On the board, a warning appears when the
head turns or tilts more than about 9°, slides about 3 cm, or comes about 6 cm closer or 8 cm further (estimated at
60 cm from the screen). The stricter calibration limits are about 4° turn, 4.6° tilt and 1.7 cm slide.

### 5.8 Signal quality

The "noise" of the eye signal is measured as the short-term spread of `irisX` while the eyes are still. Below 0.0003
counts as good, above 0.0005 as poor. Dim light is the main cause of poor signal: the camera raises its gain and the
iris points start to shimmer.

---

## 6. The board and vocabulary

- **Layout:** one row of six tall buttons. The home page shows Help, Quick talk, Food & drink, Feelings, Activities and
  Body & needs, each with small previews of the words inside. A category page shows Back plus up to five words.
  Six columns was kept on purpose: fewer, bigger buttons were proposed to make selection easier, but the developer
  preferred six, and the effort went into better calibration instead.
- **Help** is on the home page and selects in one look, so it is always quick to reach.
- **Speech:** the browser's built-in voice, or a recorded voice per word.
- **Word editor** (`editor.ts`): for parents and therapists. Change the text, the spoken sentence, the emoji or a
  photo, the colour, the phone-alert level (off, normal, urgent), and record a voice. Edits are made on a draft and
  only applied on Save. The vocabulary is validated when loaded, so damaged saved data falls back to the defaults.
  Labels are rendered as text, never as HTML, so a typed label cannot inject code.
- **Media:** photos are shrunk to 400 px JPEG; photos and recordings are stored in the browser's IndexedDB and
  cleaned up when no longer used.
- **Silence trimming** (`trimAudio.ts`): a recording starts with a pause (between clicking Record and speaking),
  which made the app feel slow. Loudness is measured per 10 ms; the threshold adapts to the room's noise
  (max(4 × noise, noise + 2 % of the range)); 80 ms before and 150 ms after the speech are kept, with 5 ms fades,
  and the result is saved as a 22 050 Hz WAV. In a browser test a 2.5 s recording became 1.34 s.

---

## 7. Phone alerts

### 7.1 Purpose

A child who can say "toilet" or "help" with their eyes still needs someone to hear it. Phone alerts send the child's
words to the parents' phones, so they work even when nobody is in the room.

### 7.2 Design

1. **Pairing.** The laptop asks the server for a *household* and receives an ID and two secrets (one for the laptop,
   one for joining). The laptop also makes a random 256-bit key **in the browser**. The QR code holds
   `phone.html#pair=household.joinSecret.key`. The part after `#` is never sent to any server, so the key reaches the
   phone through the QR code but never through our server.
2. **End-to-end encryption.** Every message, reply and even the parents' names are sealed with AES-GCM (random
   12-byte IV per message; the authentication tag means tampering is detected). The server only stores and forwards
   sealed boxes and knows only which household they belong to and whether a message is urgent.
3. **Delivery.** The server sends each message with Web Push through Google's push service (FCM), signed with its
   VAPID key, with a one-hour time-to-live and high urgency. Phones that have uninstalled are removed automatically
   (HTTP 404/410 from the push service).
4. **The phone.** A service worker wakes up on each push, unseals it, stores it, and shows a notification with
   **🏃 Coming** and **⏳ 5 minutes** buttons. Urgent messages stay on screen and vibrate strongly.
5. **Replies.** A tapped button sends a sealed reply. The laptop shows a large banner ("👍 Mum is coming") and speaks
   it, so the child knows help is coming; the other phones are told too, so not everyone comes running.
6. **Urgent repeats.** Urgent words (Help by default) are re-sent every 60 s, up to 5 times, until someone replies.
7. **Grouping.** Normal words wait for a 6-second pause (at most 15 s, up to 5 words) and go out as one notification,
   such as "💬 🍎 Hungry · 💧 Water". Urgent words go immediately and take any waiting words with them.

### 7.3 Changes made after real-phone testing

Testing on a real Android phone through a Cloudflare tunnel exposed three problems, each fixed:

| Problem found | Cause | Fix |
|---|---|---|
| Replies never appeared on the laptop | The laptop listened on one held-open connection (Server-Sent Events), which the tunnel buffered | The laptop now asks the server every 3 s ("polling"); ordinary short requests pass through any proxy |
| Replies were hidden | They appeared in the board's message line, covered by the welcome card or panels | A banner on top of every screen |
| Notifications felt like spam | Looking around the board selected several words, each sent at once | Grouping after a pause (debouncing) |

The tunnel itself first failed because the network advertised IPv6 but could not route it; forcing IPv4 and HTTP/2
fixed that (`npm run tunnel`).

### 7.4 Server safeguards

Secrets are stored only as SHA-256 hashes and compared in constant time; request bodies are limited to 16 KB;
messages are limited to 30 per minute per household; file paths are normalised to block path traversal; and only
the request path and status are logged, never contents or secrets.

---

## 8. Offline use

The board is a Progressive Web App. A service worker saves the page with *stale-while-revalidate* (start instantly
from the saved copy, update in the background) and every other file, including the MediaPipe engine and face model,
with *cache-first* (file names change when content changes). The MediaPipe files are copied into the site at build
time so that the app no longer depends on external servers. Server requests (`/api/…`) are never cached.

---

## 9. Privacy and security summary

| Data | Where it goes |
|---|---|
| Camera video and face points | Processed in the browser only. Never stored or sent |
| Calibration and edited words, photos, recordings | This browser only (localStorage, IndexedDB) |
| Phone alert contents and parent names | End-to-end encrypted; the server cannot read them |
| Calibration summary numbers and feedback (study) | Sent only after explicit consent, under a random ID; deletable by the tester at any time |
| Raw per-frame eye measurements | Only in a file the user saves themselves ("Save calibration data"); never uploaded |

The repository is public, so personal calibration recordings, server keys and `.env` files are excluded by
`.gitignore`.

---

## 10. Evaluation so far

### 10.1 Method

All sessions so far are by **one person, the developer**, on one MacBook (M1, built-in camera, 1440 × 900 browser
window), saved with "Save calibration data" and analysed offline with replay scripts that run the exact app code on
the recordings. This is enough to find and fix problems but says nothing yet about other people; Section 12 addresses
that.

### 10.2 Calibration sessions

| Session (UTC) | Conditions | Chosen recipe | Word test hit | Stress hit | Mean aim error (% width) | Jitter | Largest button lean |
|---|---|---|---|---|---|---|---|
| 14 Oct 07:13 | Morning, glasses on | Iris S-curve + head turn | 100 % | (not yet measured) | 1.3 | 0.42 | 2.8 % |
| 14 Oct 07:16 | Morning, no glasses | Iris S-curve + head turn | 100 % | (not yet measured) | 3.4 | 0.31 | 7.8 % |
| 14 Oct 14:16 | Evening, dim room | Iris 2D | 91.8 % | 65.4 % | 7.6 | 3.21 | 22.3 % |
| 15 Oct 07:02 | Morning daylight | Iris S-curve + head turn | 100 % | 79.9 % | 3.2 | 0.51 | 5.9 % |
| 20 Oct 10:06 | Afternoon daylight, column fix on | Iris S-curve | 100 % | 94.9 % | 2.6 | 1.11 | 3.8 % |

*Stress hit* was added on 14 October, after the first two sessions. One button is 16.5 % of the screen wide, so an
estimate must stay within about 8.3 % of a centre to land on the right button.

### 10.3 Findings

1. **Light matters most.** The dim evening session was the only one below 100 %: noise and jitter were several times
   higher and one button leaned by 22 % of the screen. The app now measures signal quality and tells the user to add
   light instead of recalibrating.
2. **Glasses did not hurt** in the one paired comparison; the glasses session had the lower error. One pair of
   sessions is not enough to conclude more.
3. **Per-button correction helps.** Replaying the three daylight sessions, the share of frames on the right button
   went from 96.6 / 98.8 / 100 % to 100 / 100 / 100 %; on held-out looks the average miss fell from 3.0 % to 2.4 % and
   the worst from 8.2 % to 5.3 %.
4. **Safety margin improved** across daylight sessions (stress hit 80 % → 95 %) as the calibration changes landed.
5. **Rejected idea:** correcting for the *height* at which the user looks (calibration looks sit at 30 % and 70 % of
   the button height) gave only a 1–2 % effect that was inconsistent between sessions, so it was not added.
6. The developer reported feeling "more in control" after the daylight calibration, and that recorded voices played
   promptly after silence trimming.

### 10.4 Phone alert tests

End-to-end tests in a headless browser through the real Google push service confirmed pairing, encryption (the key
never appears on the server), notification actions and replies. A real Android phone then confirmed notifications and,
after the polling fix, replies on the laptop. Urgent repeats and grouping have been tested in code simulations and
still need a real-phone test.

---

## 11. Development process and key decisions

### 11.1 Timeline

| Dates | Milestone |
|---|---|
| 12 Oct | Webcam + face landmarks, 9-point calibration, regression model, smoothing, first 5-word board with dwell and speech |
| 13 Oct | Task-specific calibration, cross-validated model choice, category pages, Help, slow-looker handling, quick fix, data export |
| 14 Oct | Drift correction, offline mode, recipe choice by word test and safety margin, head guard, signal quality |
| 15 Oct | Smoother calibration star; word editor |
| 16 Oct | Silence trimming; per-button correction; phone alerts with end-to-end encryption |
| 17–22 Oct | Documentation and tooling; real-phone test, polling and grouping (20 Oct) |
| 27 Oct | Deployment set-up (Render + Neon), consent screen, feedback form, study data export, this report |

### 11.2 Decisions and what they taught

| Decision | Alternatives considered | Reason |
|---|---|---|
| Six large buttons in one row | Fewer, bigger buttons; a grid | Webcam accuracy is best side to side; the developer preferred six, so calibration was improved instead |
| Choose recipes on a held-out word test with a stress margin | Cross-validation only | Cross-validation missed edge-button errors |
| Keep the steadiest 800 ms of each look | Fixed delay after the star arrives | Adapts to slow and fast lookers, skips blinks |
| Correct per button at 80 % | Full correction; no correction | Systematic per-button error dominated; 80 % avoids correcting noise |
| Own phone app with Web Push | Third-party notification app; native app | No extra install for parents, end-to-end encryption, replies |
| Polling every 3 s | Server-Sent Events | SSE was buffered by a tunnel; polling works through any proxy |
| Group words after a pause | One notification per word | Looking around caused bursts of notifications |
| Render + Neon free tiers | Railway, Fly.io | Free and no card; the database keeps data across restarts |
| Adults-only first study, minimal data | Children; recording all usage | Safest first step; collect only what answers current questions |

A general lesson from this project: **measure, then change one thing.** Several plausible ideas (look-height
correction, a bigger board) were tested against recorded data or the user's experience and dropped, while the
per-button correction, which the data clearly supported, was kept.

---

## 12. Deployment and user study

### 12.1 Deployment

The app and the relay server are one Node.js service. The `render.yaml` Blueprint tells Render to install, build
(`npm ci && npm run build`) and start (`npm run server`) it in the Singapore region, the closest to Nepal, and to
redeploy on every push to `main`. HTTPS is provided by Render, which also makes phone notifications work without a
tunnel.

Hosting services wipe their local disk on restart, so with `DATABASE_URL` set the server stores everything in
Postgres (Neon, free tier) instead of files: the push keys and pairings as one JSON document, and study records in
their own table. Without `DATABASE_URL` (on a laptop) it keeps using JSON files.

The free server sleeps after about 15 minutes without visitors, and the first visit afterwards takes about a minute.
Testers are told this. Once loaded, the board itself works offline.

### 12.2 Who and how

The first round is for **adults only**: friends, classmates, teachers and professionals who try the board on
themselves, then fill in a feedback form. Testing with children is deliberately left for later, after this round and
with proper ethical review.

### 12.3 Consent

On the first visit, a consent screen explains in plain words what is collected, what is never collected, how it is
used and how to leave. The tester must confirm they are 18 or older and agree before the **Take part** button works;
**No thanks** leaves the app fully usable. The choice is remembered in the browser. Consent is recorded (with its
version number), and **Feedback → Leave the study and delete my data** deletes every record from that browser on the
server.

### 12.4 Data collected (only after consent)

| Record | Contents |
|---|---|
| `consent` | Consent version and time |
| `calibration` | Per calibration: chosen recipes, all candidate scores, hit and stress rates, per-button hits and leans, aim error, jitter, signal noise, per-button corrections, head reference pose, button positions, number of looks (shows redos), duration, attempt number, screen size, browser; failed calibrations with their error message |
| `feedback` | Role (student, parent, therapist…), light, glasses; seven 1–5 agreement ratings (calibration ease, accuracy, speed, comfort, editor, phone alerts, usefulness); three free-text answers; screen and browser |

Not collected: video, images, names, emails, IP addresses, chosen words, voice recordings, alert contents, or
per-frame eye measurements. Records are linked only by a random ID generated in the browser. If the server cannot be
reached, records wait in the browser and are sent later.

### 12.5 Getting the data

The researcher downloads everything from `/api/study/export` with the admin token (as JSON, or as CSV for a
spreadsheet with `?format=csv`). Nested values become columns such as `score.hitRate`; free-text answers that start
with `=` are escaped so they cannot run as spreadsheet formulas.

### 12.6 Questions the study should answer

1. How often does calibration pass on the first try across different people, laptops and rooms?
2. How do hit rate and safety margin relate to light, glasses and screen size?
3. Which recipe wins most often? Is the S-curve still the best default?
4. Which parts feel hardest (calibration, speed, comfort) according to the ratings and comments?
5. Do people who are not the developer find the editor and phone alerts usable?

---

## 13. Limitations

- **One tester so far.** All quantitative results come from the developer. They do not generalise yet.
- **Not tested with children**, and not a medical device. Children move more, look away more and may not follow a
  star; calibration may need a game-like design for them.
- **Head movement.** Large head movements need a quick fix or recalibration.
- **Light.** Dim light degrades accuracy considerably.
- **Phone alerts** depend on the internet, the relay server and Android's push delivery, which can be delayed by
  battery saving. They support supervision; they do not replace it. iPhones are untested.
- **Free hosting** sleeps when idle and has limited resources; it suits a study, not a service people rely on.
- **Browser support.** Tested in Chromium-based browsers (Brave, Chrome).

---

## 14. Future work

- Run the adult study; analyse the results; adjust defaults (dwell time, recipe order, gate thresholds).
- A child-friendly calibration (a character or animation instead of a star, shorter, with rewards).
- Back up and share word sets as a file; more vocabulary (people, a simple keyboard).
- Escalation: if nobody answers an urgent alert, alert a second caregiver.
- Paid or self-managed hosting with monitoring once real families depend on it.
- With ethical approval and expert guidance (speech therapists, special educators), a supervised study with children.

---

## 15. Conclusion

In about two weeks, Swar Netra grew from a webcam demo into a working eye-gaze communication board. It
calibrates itself with built-in checks, corrects its own drift, lets caregivers adapt it, reaches parents' phones
securely, and works offline. With good light it chose the right button in every test look of the developer's
sessions. The next step is to find out whether that holds for other people, which the hosted version and the
consent-based study are now ready to measure.

---

## References

1. Tager-Flusberg, H., & Kasari, C. (2013). Minimally verbal school-aged children with autism spectrum disorder: the
   neglected end of the spectrum. *Autism Research*, 6(6), 468–478.
2. Papoutsaki, A., Sangkloy, P., Laskey, J., Daskalova, N., Huang, J., & Hays, J. (2016). WebGazer: Scalable webcam
   eye tracking using user interactions. *Proceedings of IJCAI 2016*.
3. Google. MediaPipe Face Landmarker. https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker
4. Casiez, G., Roussel, N., & Vogel, D. (2012). 1€ Filter: A simple speed-based low-pass filter for noisy input in
   interactive systems. *Proceedings of CHI 2012*, 2527–2530.

---

## Appendix A: Main parameters

| Parameter | Value | File |
|---|---|---|
| Dwell time | 1.2 s | `src/dwell.ts` |
| Dwell drain rate / unlock time | 60 % / 400 ms | `src/dwell.ts` |
| Star move / settle / record / kept window | 600 / 200 / 1600 / 800 ms | `src/calibration.ts` |
| Quality gate / maximum redos | 70 % / 2 | `src/calibrationFlow.ts` |
| Stress shift | 3 % of screen width | `src/evaluate.ts` |
| Ridge λ | 0.01 | `src/gazeModel.ts` |
| Column fix strength / cap | 80 % / 6 % | `src/columnFix.ts` |
| One Euro Filter min cutoff / β | 0.4 / 2.0 | `src/smoothing.ts` |
| Drift: fixation / rate / cap | 400 ms / 5 % / 8 % | `src/driftTracker.ts` |
| Signal noise good / poor | < 0.0003 / > 0.0005 | `src/signalQuality.ts` |
| Alert grouping: quiet / max wait / max words | 6 s / 15 s / 5 | `src/alerts.ts` |
| Same-word skip | 20 s | `src/alerts.ts` |
| Reply polling | 3 s | `src/alerts.ts` |
| Urgent repeats | every 60 s, up to 5 | `server/server.ts` |
| Messages per household | 30 per minute | `server/server.ts` |
| Study requests per address | 20 per minute | `server/server.ts` |

## Appendix B: Running it

```bash
npm install
npm run build
npm run server          # http://localhost:8787 (files in server/data/)
npm run tunnel          # optional: temporary https address for a real phone
```

Online, Render runs the same commands from `render.yaml`, with `DATABASE_URL` and `ADMIN_TOKEN` set in its dashboard.
