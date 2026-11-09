import { describe, expect, it } from 'vitest'
import { automaticBlink, gestureDuration, gestureProgress } from './avatar-motion'

describe('3D avatar motion', () => {
  it('starts and ends a gesture at rest', () => {
    for (const duration of [300, 1100, 1500]) {
      expect(gestureProgress(0, duration)).toBe(0)
      expect(gestureProgress(duration, duration)).toBe(0)
      expect(gestureProgress(duration / 2, duration)).toBeCloseTo(1)
      expect(gestureProgress(duration * 2, duration)).toBe(0)
    }
  })

  it('keeps eyes open outside the short blink window', () => {
    expect(automaticBlink(0)).toBe(0)
    expect(automaticBlink(2)).toBe(0)
    expect(automaticBlink(3.9)).toBe(0)
    expect(automaticBlink(4.03)).toBeCloseTo(1)
    expect(automaticBlink(4.2)).toBe(0)
  })

  it('selects a finite duration for each supported gesture', () => {
    for (const gesture of ['hello', 'nod', 'blink', null] as const) {
      expect(gestureDuration(gesture)).toBeGreaterThan(0)
    }
  })
})
