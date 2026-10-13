// Persistence: save the calibration in the browser so a page refresh doesn't
// mean calibrating again. The user just puts their head back where it was
// (nose in the circle), and the saved model works again.
//
// localStorage is a small key → text store that belongs to this website, on this
// computer only. Nothing is uploaded anywhere.

import type { SavedModel } from './gazeModel.ts'
import type { HeadPose } from './headGuard.ts'

// The "v1" is a schema version. If we change what we save in the future, we bump it
// to "v2", so the app never tries to read old data in the wrong shape.
const KEY = 'swar-netra-calibration-v1'

export type SavedCalibration = {
  xModel: SavedModel // model used for left/right
  yModel: SavedModel // model used for up/down
  headRef: HeadPose // where the head was during calibration
  hitRate: number // test result, shown to the caregiver
  savedAt: string // when it was made
}

export function saveCalibration(c: SavedCalibration): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    // Storage can be blocked (e.g. private browsing). The app still works, just without saving.
  }
}

export function loadCalibration(): SavedCalibration | null {
  try {
    const text = localStorage.getItem(KEY)
    return text ? (JSON.parse(text) as SavedCalibration) : null
  } catch {
    return null
  }
}

export function clearCalibration(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // nothing to do
  }
}
