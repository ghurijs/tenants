/**
 * A UUID version 7 (RFC 9562): 48-bit Unix milliseconds + 74 random bits. Sorts by creation time, so it indexes
 * like an auto-increment key while staying unique across databases (one tenant can move to its own database).
 * Use it as a default: `new UUIDField({ primaryKey: true, default: uuid7 })`.
 */
export function uuid7(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  const ms = Date.now()
  b[0] = Math.floor(ms / 2 ** 40) & 0xff
  b[1] = Math.floor(ms / 2 ** 32) & 0xff
  b[2] = Math.floor(ms / 2 ** 24) & 0xff
  b[3] = Math.floor(ms / 2 ** 16) & 0xff
  b[4] = Math.floor(ms / 2 ** 8) & 0xff
  b[5] = ms & 0xff
  b[6] = (b[6] & 0x0f) | 0x70 // version 7
  b[8] = (b[8] & 0x3f) | 0x80 // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Unix milliseconds encoded in a UUIDv7. */
export function uuid7Time(id: string): number {
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)
}
