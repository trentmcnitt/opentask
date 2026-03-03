/**
 * Generate VAPID keys for Web Push notifications.
 *
 * Used by docker-entrypoint.sh on first start to auto-generate keys
 * so push notifications work out of the box.
 *
 * Uses Node.js built-in crypto (no external dependencies) to generate
 * an EC P-256 key pair in base64url format, matching web-push's generateVAPIDKeys().
 *
 * Usage: node scripts/generate-vapid-keys.mjs <output-file>
 *
 * Output format (shell-sourceable):
 *   VAPID_PUBLIC_KEY=...
 *   VAPID_PRIVATE_KEY=...
 */

import { createECDH } from 'crypto'
import { writeFileSync } from 'fs'

const outputFile = process.argv[2]
if (!outputFile) {
  console.error('Usage: node scripts/generate-vapid-keys.mjs <output-file>')
  process.exit(1)
}

const curve = createECDH('prime256v1')
curve.generateKeys()

// Public key in uncompressed form (65 bytes, 0x04 prefix)
const publicKey = curve.getPublicKey()

// Private key must be exactly 32 bytes (zero-pad if shorter)
let privateKey = curve.getPrivateKey()
if (privateKey.length < 32) {
  privateKey = Buffer.concat([Buffer.alloc(32 - privateKey.length), privateKey])
}

const content = [
  `VAPID_PUBLIC_KEY=${publicKey.toString('base64url')}`,
  `VAPID_PRIVATE_KEY=${privateKey.toString('base64url')}`,
  '',
].join('\n')

writeFileSync(outputFile, content, { mode: 0o600 })
console.log('Generated VAPID keys and saved to ' + outputFile)
