// Signal quality: how clearly can the camera see the eyes right now?
//
// Measured as the typical (median) jump of the iris position from one frame to the next.
// Real eye movements are big but rare jumps; the median ignores them. What's left is the
// constant small wobble of the landmark detector: its noise. Dim light makes the camera
// boost its gain, which makes the image grainy and this wobble bigger.
//
// Thresholds come from real sessions: good daytime sessions had 0.00013-0.00018,
// an evening session with 5x less clear signal had 0.00070.

import type { Recording } from './calibration.ts'

const GOOD = 0.0003
const POOR = 0.0005
const WINDOW_MS = 2000

export type SignalLevel = 'good' | 'fair' | 'poor'

export function signalLevel(noise: number): SignalLevel {
  return noise < GOOD ? 'good' : noise < POOR ? 'fair' : 'poor'
}

export const SIGNAL_ADVICE =
  'Add light in front of you (e.g. a lamp behind the screen, facing you) and avoid bright light behind you.'

const median = (vs: number[]) => [...vs].sort((a, b) => a - b)[Math.floor(vs.length / 2)]

// Live meter: feed it every frame, read the noise over the last 2 seconds.
export class NoiseMeter {
  private jumps: { t: number; v: number }[] = []
  private last: number | null = null

  push(irisX: number, now: number): void {
    if (this.last !== null) this.jumps.push({ t: now, v: Math.abs(irisX - this.last) })
    this.last = irisX
    while (this.jumps.length && this.jumps[0].t < now - WINDOW_MS) this.jumps.shift()
  }

  // Forget the last frame, e.g. when the face was lost (the next jump would be meaningless).
  gap(): void {
    this.last = null
  }

  noise(): number | null {
    return this.jumps.length >= 20 ? median(this.jumps.map((j) => j.v)) : null
  }
}

// The same measure over calibration recordings (jumps within each spot).
export function recordingNoise(recordings: Recording[]): number {
  const jumps = recordings.flatMap((r) => r.frames.slice(1).map((f, i) => Math.abs(f.irisX - r.frames[i].irisX)))
  return jumps.length ? median(jumps) : Infinity
}
