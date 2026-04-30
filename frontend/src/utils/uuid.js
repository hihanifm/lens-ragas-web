// Prefer the platform UUID when available; fall back for older browsers.
export function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  // RFC4122-ish v4 fallback (not cryptographically strong, but good enough for UI run IDs).
  const rnd = () => Math.floor(Math.random() * 0xffffffff)
  const hex = (n, len) => n.toString(16).padStart(len, '0')
  const a = rnd()
  const b = rnd()
  const c = rnd()
  const d = rnd()

  // Set version (4) and variant (10xx)
  const timeHiAndVersion = (c & 0x0fff) | 0x4000
  const clockSeqHiAndReserved = (d & 0x3fff) | 0x8000

  return (
    `${hex(a, 8)}-` +
    `${hex(b >>> 16, 4)}-` +
    `${hex(b & 0xffff, 4)}-` +
    `${hex(timeHiAndVersion, 4)}-` +
    `${hex(clockSeqHiAndReserved, 4)}${hex(d & 0xffff, 4)}`
  )
}

