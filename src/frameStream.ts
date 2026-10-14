// Observer pattern ("pub/sub"): the main loop PUBLISHES each frame's readings,
// and any module that needs them SUBSCRIBES. The loop doesn't need to know who
// is listening, which keeps the modules independent of each other.

import type { EyeFeatures } from './eyeFeatures.ts'
import type { HeadPose } from './headGuard.ts'

export type FrameInfo = { features: EyeFeatures; pose: HeadPose; aspect: number }
type Listener = (info: FrameInfo) => void

export class FrameStream {
  private listeners = new Set<Listener>()

  // Start listening. Returns a function that stops listening.
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(info: FrameInfo): void {
    for (const listener of this.listeners) listener(info)
  }
}
