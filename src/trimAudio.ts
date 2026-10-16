// Trim the silence around a voice recording, so the word starts the moment it's chosen.
//
// A recording always begins with a pause (the time between clicking Record and speaking)
// and ends with one (between finishing and clicking Stop). Played back, that first pause
// sounds like the app is slow.
//
// How: sound is a long list of numbers ("samples", e.g. 22 050 per second), each one how
// far the microphone membrane was pushed at that instant. Silence = numbers near 0, speech
// = big swings. We measure the loudness of every 10 ms slice, find the first and last
// slice that is clearly louder than the background noise, and keep only that part, plus a
// little margin so soft sounds at the edges (the breathy "h" of "hungry") aren't cut off.

const RATE = 22050 // samples per second: plenty for speech, and half the file size of 44 100
const SLICE_S = 0.01 // loudness is measured per 10 ms slice
const KEEP_BEFORE_S = 0.08 // margin kept before the first loud slice (soft starting sounds)
const KEEP_AFTER_S = 0.15 // margin kept after the last loud slice (sounds fade out slowly)
const FADE_S = 0.005 // tiny fade in/out, so cutting mid-sound doesn't make a "click"

// Where the speech is, as [first sample, end sample]. Pure math, so it can be tested alone.
export function speechBounds(samples: Float32Array, rate: number): [number, number] {
  const slice = Math.max(1, Math.round(rate * SLICE_S))
  const loudness: number[] = []
  for (let i = 0; i < samples.length; i += slice) {
    let sum = 0
    const end = Math.min(samples.length, i + slice)
    for (let j = i; j < end; j++) sum += samples[j] * samples[j]
    loudness.push(Math.sqrt(sum / (end - i))) // RMS: the slice's average loudness
  }
  if (!loudness.length) return [0, samples.length]

  // Background noise = how loud the quietest slices are (every recording has some hiss).
  const sorted = [...loudness].sort((a, b) => a - b)
  const noise = sorted[Math.floor(sorted.length * 0.1)]
  const peak = sorted[sorted.length - 1]
  // "Clearly louder than the noise": at least 4x the noise, and 2% of the way from the
  // noise up to the loudest moment (so a loud room doesn't count as speech).
  const threshold = Math.max(noise * 4, noise + 0.02 * (peak - noise))
  if (peak < 1e-4 || peak < noise * 2) return [0, samples.length] // all silence/noise: leave it

  const first = loudness.findIndex((l) => l > threshold)
  const last = loudness.length - 1 - [...loudness].reverse().findIndex((l) => l > threshold)
  const start = Math.max(0, first * slice - Math.round(KEEP_BEFORE_S * rate))
  const end = Math.min(samples.length, (last + 1) * slice + Math.round(KEEP_AFTER_S * rate))
  return [start, end]
}

// Package samples as a WAV file: a 44-byte header describing the format, then the samples
// as plain 16-bit numbers. WAV isn't compressed, so the browser can start playing it
// instantly (no decoding step), and nothing is lost: it is exactly your voice.
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true) // size of this format block
  view.setUint16(20, 1, true) // 1 = plain (PCM) samples
  view.setUint16(22, 1, true) // 1 channel (mono)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // bytes per second
  view.setUint16(32, 2, true) // bytes per sample
  view.setUint16(34, 16, true) // bits per sample
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true))
  return new Blob([view], { type: 'audio/wav' })
}

// Recording (any format the browser recorded in) → trimmed WAV.
export async function trimSilence(recording: Blob): Promise<Blob> {
  // An OfflineAudioContext decodes sound without playing it, and converts it to RATE.
  const audio = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await recording.arrayBuffer())
  const samples = audio.getChannelData(0)
  const [start, end] = speechBounds(samples, RATE)
  const kept = samples.slice(start, end)
  const fade = Math.min(Math.round(FADE_S * RATE), Math.floor(kept.length / 2))
  for (let i = 0; i < fade; i++) {
    kept[i] *= i / fade
    kept[kept.length - 1 - i] *= i / fade
  }
  return encodeWav(kept, RATE)
}
