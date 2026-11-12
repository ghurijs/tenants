import { afterEach, describe, expect, it } from 'vitest'
import { uuid7, uuid7Time } from '../src'
import { setUuid7Clock, setUuid7State, UUID7_COUNTER_MAX } from '../src/uuid'

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The 42-bit counter: rand_a (12 bits) and the high 30 bits of rand_b. */
function counterOf(id: string): number {
  const h = id.replace(/-/g, '')
  return Number.parseInt(h.slice(13, 16), 16) * 2 ** 30 + (Number.parseInt(h.slice(16, 24), 16) & 0x3fffffff)
}

function expectIncreasing(ids: string[]): void {
  for (let i = 1; i < ids.length; i++) {
    if (!(ids[i - 1] < ids[i])) throw new Error(`not increasing at ${i}: ${ids[i - 1]} >= ${ids[i]}`)
  }
  expect(new Set(ids).size).toBe(ids.length)
}

describe('uuid7', () => {
  afterEach(() => {
    setUuid7Clock()
    setUuid7State()
  })

  it('is a version 7, variant 10 UUID with the creation time', () => {
    const before = Date.now()
    const ids = Array.from({ length: 50 }, () => uuid7())
    for (const id of ids) {
      expect(id).toMatch(UUID7)
      const bytes = id.replace(/-/g, '')
      expect(bytes[12]).toBe('7') // version nibble
      expect(Number.parseInt(bytes[16], 16) >> 2).toBe(0b10) // variant bits
      expect(uuid7Time(id)).toBeGreaterThanOrEqual(before)
      expect(uuid7Time(id)).toBeLessThanOrEqual(Date.now())
    }
  })

  it('is strictly increasing and unique in a tight loop', () => {
    const ids: string[] = []
    for (let i = 0; i < 10_000; i++) ids.push(uuid7())
    expectIncreasing(ids)
    for (const id of ids) expect(id).toMatch(UUID7)
  })

  it('counts up within one millisecond and reseeds at the next', () => {
    let now = 1_700_000_000_000
    setUuid7Clock(() => now)
    const burst = Array.from({ length: 5000 }, () => uuid7())
    expectIncreasing(burst)
    for (const id of burst) expect(uuid7Time(id)).toBe(now)
    // A random seed below 2^41, then +1 per id.
    expect(counterOf(burst[0])).toBeLessThan(2 ** 41)
    for (let i = 1; i < burst.length; i++) expect(counterOf(burst[i])).toBe(counterOf(burst[i - 1]) + 1)
    // The random tail differs even though the counter does the ordering.
    expect(new Set(burst.map((id) => id.slice(-8))).size).toBeGreaterThan(4900)

    now += 1
    const next = uuid7()
    expect(uuid7Time(next)).toBe(now)
    expect(next > burst[burst.length - 1]).toBe(true)
  })

  it('stays monotonic when the clock goes backwards, reusing the last timestamp', () => {
    let now = 1_700_000_000_500
    setUuid7Clock(() => now)
    const a = uuid7()
    now -= 400 // NTP step back
    const b = uuid7()
    const c = uuid7()
    expect(a < b && b < c).toBe(true)
    expect(uuid7Time(b)).toBe(1_700_000_000_500)
    expect(uuid7Time(c)).toBe(1_700_000_000_500)
    expect(counterOf(b)).toBe(counterOf(a) + 1)
    now = 1_700_000_000_501 // the clock catches up
    const d = uuid7()
    expect(d > c).toBe(true)
    expect(uuid7Time(d)).toBe(now)
  })

  it('advances the timestamp field when the counter overflows', () => {
    const now = 1_700_000_001_000
    setUuid7Clock(() => now)
    setUuid7State(now, UUID7_COUNTER_MAX - 1)
    const last = uuid7()
    expect(counterOf(last)).toBe(UUID7_COUNTER_MAX)
    expect(uuid7Time(last)).toBe(now)
    expect(last).toMatch(UUID7)

    const borrowed = uuid7()
    expect(borrowed > last).toBe(true)
    expect(borrowed).toMatch(UUID7)
    expect(uuid7Time(borrowed)).toBe(now + 1) // ahead of the clock by one millisecond
    expect(counterOf(borrowed)).toBeLessThan(2 ** 41)

    // Still the same wall-clock millisecond: keep counting under the borrowed timestamp.
    const after = uuid7()
    expect(after > borrowed).toBe(true)
    expect(uuid7Time(after)).toBe(now + 1)
  })
})
