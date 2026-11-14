// Lucent Raw licence keys. Uses only Node's built-in crypto (Ed25519).
//   node tools/licence.mjs keypair <folder>                   make private.pem and public.txt in <folder> (once)
//   node tools/licence.mjs sign <private.pem> "<name>" <email> [edition=1]   print a licence key
// The private key signs licences and must never be put in the project or sent anywhere. The program holds only the public key
// (the 32 bytes printed by `keypair`, in app/src-tauri/src/licence.rs). A key looks like  LRAW1.<payload>.<signature>.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const b64u = (b) => Buffer.from(b).toString('base64url')
const [cmd, a, b, c, d] = process.argv.slice(2)
if (cmd === 'keypair') {
  mkdirSync(a, { recursive: true })
  if (existsSync(join(a, 'private.pem'))) throw new Error('private.pem already exists there; not replacing it')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(join(a, 'private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  writeFileSync(join(a, 'public.txt'), [...raw].join(', ') + '\n')
  console.log('public key bytes for licence.rs:\n' + [...raw].join(', '))
} else if (cmd === 'sign') {
  const key = createPrivateKey(readFileSync(a))
  const payload = JSON.stringify({ v: 1, name: b, email: c, edition: d ?? '1', issued: new Date().toISOString().slice(0, 10) })
  const p = b64u(payload)
  const sig = sign(null, Buffer.from(p), key)
  console.log(`LRAW1.${p}.${b64u(sig)}`)
  void createPublicKey
} else {
  console.log('usage: see the top of this file')
  process.exit(1)
}
