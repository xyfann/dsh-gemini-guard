// Path-awareness test: recognizing the fake-IP space that domain-splitting
// tunnels use, so the guard can stop trusting a geolocation probe that measures
// a different path.
//
// Run: node test/path.mjs
import { detectSplitTunnel, isNonPublicAddress } from '../egress-path.js'

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
}

const fakeAddresses = [
  '198.18.0.178',
  '198.19.255.1',
  '10.1.2.3',
  '172.16.0.9',
  '172.31.255.1',
  '192.168.1.1',
  '100.64.0.1',
  '127.0.0.1',
  '169.254.10.10',
  '::1',
  'fe80::1',
  'fd00::1',
]

for (const address of fakeAddresses) {
  check(`non-public: ${address}`, isNonPublicAddress(address) === true, String(isNonPublicAddress(address)))
}

const publicAddresses = ['208.95.112.1', '34.117.59.81', '8.8.8.8', '1.1.1.1', '104.26.12.205', '192.0.2.10', '2001:4860:4860::8888']
for (const address of publicAddresses) {
  check(`public: ${address}`, isNonPublicAddress(address) === false, String(isNonPublicAddress(address)))
}

check('malformed input is not treated as non-public', isNonPublicAddress('not-an-ip') === false)
check('empty input is not treated as non-public', isNonPublicAddress('') === false)
check('non-string input is not treated as non-public', isNonPublicAddress(undefined) === false)

// The shapes a resolver actually returns.
check('detects the split-tunnel marker', detectSplitTunnel(['198.18.0.178']) === '198.18.0.178')
check('detects a marker among public addresses', detectSplitTunnel(['203.0.113.9', '198.18.0.162']) === '198.18.0.162')
check('a public-only host is not a split tunnel', detectSplitTunnel(['208.95.112.1']) === null)
check('an empty answer is not a split tunnel', detectSplitTunnel([]) === null)
check('a failed lookup is not a split tunnel', detectSplitTunnel(undefined) === null)

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
