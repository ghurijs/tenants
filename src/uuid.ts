// UUIDv7 (RFC 9562), monotonic within a process (§6.2, "fixed bit-length dedicated counter", method 1).
//
// Layout:  unix_ts_ms (48) | ver = 7 (4) | rand_a (12) | var = 10 (2) | rand_b (62)
// Counter: rand_a (12) + the high 30 bits of rand_b = 42 bits. It is seeded with 41 random bits at each new
//          millisecond (the top bit starts at 0, so at least 2^41 ids fit in one millisecond) and incremented
//          by one for every further id in the same millisecond.
// Random:  the low 32 bits of rand_b are fresh random bits on every call.

const COUNTER_BITS = 42
const RANDOM_HIGH = 2 ** 30 // rand_b's high 30 bits hold the counter's low part
/** Largest counter value (42 bits). */
export const UUID7_COUNTER_MAX = 2 ** COUNTER_BITS - 1

let clock: () => number = Date.now
let lastMs = Number.NEGATIVE_INFINITY
let counter = 0

/** 41 random bits: a fresh counter seed. */
function seed(random: Uint8Array): number {
  return (
    (random[0] & 0x01) * 2 ** 40 +
    random[1] * 2 ** 32 +
    random[2] * 2 ** 24 +
    random[3] * 2 ** 16 +
    random[4] * 2 ** 8 +
    random[5]
  )
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

/**
 * A UUID version 7 (RFC 9562): 48-bit Unix milliseconds, a 42-bit counter and 32 random bits. Sorts by creation
 * time, so it indexes like an auto-increment key while staying unique across databases (one tenant can move to
 * its own database). Use it as a default: `new UUIDField({ primaryKey: true, default: uuid7 })`.
 *
 * Ids from one process (one Worker isolate, one Node process) are strictly increasing, also within one
 * millisecond, so ordering by `id` keeps insertion order for rows created together (RFC 9562 §6.2, method 1).
 * If the system clock goes backwards, the last timestamp is reused until the clock catches up; if the counter
 * overflows (more than 2^41 ids in one millisecond), the timestamp field is advanced by one. Ids from different
 * processes are ordered by time only.
 */
export function uuid7(): string {
  const random = new Uint8Array(10)
  crypto.getRandomValues(random)
  const now = clock()
  if (now > lastMs) {
    lastMs = now
    counter = seed(random)
  } else if (counter < UUID7_COUNTER_MAX) {
    // Same millisecond, or the clock went backwards: keep the last timestamp and count up.
    counter++
  } else {
    // Counter overflow: borrow the next millisecond.
    lastMs++
    counter = seed(random)
  }
  const ms = lastMs
  const randA = Math.floor(counter / RANDOM_HIGH) // 12 bits
  const randBHigh = counter % RANDOM_HIGH // 30 bits
  const b = new Uint8Array(16)
  b[0] = Math.floor(ms / 2 ** 40) & 0xff
  b[1] = Math.floor(ms / 2 ** 32) & 0xff
  b[2] = Math.floor(ms / 2 ** 24) & 0xff
  b[3] = Math.floor(ms / 2 ** 16) & 0xff
  b[4] = Math.floor(ms / 2 ** 8) & 0xff
  b[5] = ms & 0xff
  b[6] = 0x70 | (randA >>> 8) // version 7
  b[7] = randA & 0xff
  b[8] = 0x80 | (randBHigh >>> 24) // variant 10
  b[9] = (randBHigh >>> 16) & 0xff
  b[10] = (randBHigh >>> 8) & 0xff
  b[11] = randBHigh & 0xff
  b[12] = random[6]
  b[13] = random[7]
  b[14] = random[8]
  b[15] = random[9]
  let h = ''
  for (const x of b) h += HEX[x]
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * Unix milliseconds encoded in a UUIDv7. For ids from `uuid7()` this is the creation time, except that it can be
 * slightly ahead of the wall clock: after a counter overflow (the timestamp field is advanced by one) or while
 * the system clock is behind a time it already reported (the last timestamp is reused).
 */
export function uuid7Time(id: string): number {
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)
}

/**
 * @internal Test hook (not exported from the package entry): replace the clock `uuid7()` reads (default
 * `Date.now`). Call with no argument to restore it. The generator state is kept, as it is when a real clock
 * moves.
 */
export function setUuid7Clock(fn?: () => number): void {
  clock = fn ?? Date.now
}

/**
 * @internal Test hook (not exported from the package entry): set the last timestamp and counter, e.g. to
 * `UUID7_COUNTER_MAX` to test overflow. With no arguments the state is reset, as in a fresh process.
 */
export function setUuid7State(ms = Number.NEGATIVE_INFINITY, value = 0): void {
  lastMs = ms
  counter = value
}
