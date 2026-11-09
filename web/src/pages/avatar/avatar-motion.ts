export type AvatarGesture = 'hello' | 'nod' | 'blink' | null

/** Time-based instead of frame-count-based: different screens play the same gesture. */
export function gestureProgress(elapsedMs: number, durationMs: number): number {
  if (elapsedMs <= 0 || elapsedMs >= durationMs) return 0
  return Math.sin(Math.PI * elapsedMs / durationMs)
}

/** Natural blinks are brief; a small asymmetric interval avoids a metronome feel. */
export function automaticBlink(elapsedSeconds: number): number {
  const phase = elapsedSeconds % 5.3
  if (phase < 3.9 || phase > 4.16) return 0
  return Math.sin(Math.PI * (phase - 3.9) / 0.26)
}

export function gestureDuration(gesture: AvatarGesture): number {
  return gesture === 'hello' ? 1500 : gesture === 'nod' ? 1100 : 300
}
