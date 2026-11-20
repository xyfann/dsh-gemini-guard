// Egress path awareness.
//
// A domain-splitting tunnel (smart routing) resolves the vendor host to a fake
// address in a private range and routes only that range into the tunnel. A
// third-party geolocation service is usually *not* on the tunnel's list, so it
// measures the direct path instead. Gating a request on that measurement blocks
// traffic that would actually have left through the right exit.
//
// The marker is observable: the vendor host resolves into a non-public range.
// When that happens the country evidence is not representative, and the honest
// decision is to stop gating on it and let the vendor's own refusal decide.

const NON_PUBLIC_RANGES = [
  ['198.18.0.0', 15], // benchmarking range, used as fake-IP space by split tunnels
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['0.0.0.0', 8],
]

function ipv4ToInt(address) {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = (value * 256) + octet
  }
  return value
}

/**
 * True for loopback, link-local, CGNAT, RFC1918, and the benchmarking range that
 * split tunnels commonly use as their fake-IP space.
 */
export function isNonPublicAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  if (address.includes(':')) {
    // IPv6: loopback, link-local, and the unique-local block.
    const lower = address.toLowerCase()
    return lower === '::1'
      || lower.startsWith('fe80:')
      || lower.startsWith('fc') || lower.startsWith('fd')
      || lower === '::'
  }
  const value = ipv4ToInt(address)
  if (value === null) return false
  for (const [base, bits] of NON_PUBLIC_RANGES) {
    const baseValue = ipv4ToInt(base)
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
    if (((value & mask) >>> 0) === ((baseValue & mask) >>> 0)) return true
  }
  return false
}

/**
 * A vendor host resolving into a non-public range means a tunnel rewrote its
 * DNS and captures that traffic — the "smart split" shape. Returns the marker
 * address so it can be reported.
 */
export function detectSplitTunnel(addresses) {
  if (!Array.isArray(addresses)) return null
  for (const address of addresses) {
    if (isNonPublicAddress(address)) return address
  }
  return null
}
