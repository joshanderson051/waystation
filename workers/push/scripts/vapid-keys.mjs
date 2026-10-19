#!/usr/bin/env node
// Generates a VAPID key pair for the push worker with WebCrypto. Nothing leaves this machine.
//   npm run keys                 prints both keys and what to do with them
//   npm run keys -- --dev-vars   also writes .dev.vars (git-ignored) so `npm run dev` can send real pushes locally
//   npm run keys -- --dev-vars --force   overwrite an existing .dev.vars
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVapidKeys } from '../src/webpush.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const { publicKey, privateKey } = await generateVapidKeys();

console.log('');
console.log('VAPID public key   (goes in wrangler.toml as VAPID_PUBLIC_KEY):');
console.log(`  ${publicKey}`);
console.log('');
console.log('VAPID private key  (a secret: only ever paste it into `wrangler secret put`):');
console.log(`  ${privateKey}`);
console.log('');
console.log('Next:');
console.log(`  1. In wrangler.toml set   VAPID_PUBLIC_KEY = "${publicKey}"`);
console.log('  2. Run   npx wrangler secret put VAPID_PRIVATE_KEY   and paste the private key when asked.');
console.log('Keep the two together. A new pair silently invalidates every existing subscription:');
console.log('players would have to switch notifications off and on again.');

if (args.includes('--dev-vars')) {
  const file = resolve(here, '..', '.dev.vars');
  if (existsSync(file) && !args.includes('--force')) {
    console.log(`\n.dev.vars already exists; add --force to overwrite it.`);
  } else {
    writeFileSync(file, [
      '# Local secrets and overrides for `npm run dev` (wrangler dev). Git-ignored. Never commit.',
      `VAPID_PRIVATE_KEY=${privateKey}`,
      `VAPID_PUBLIC_KEY=${publicKey}`,
      'ALLOWED_ORIGIN=http://localhost:8787,http://127.0.0.1:8787,http://localhost:8788,http://127.0.0.1:8788',
      '# lets test/e2e-local.mjs register its fake push service on 127.0.0.1 (never set this on a deployed worker)',
      'DEV_ALLOW_LOCAL_ENDPOINT=1',
      '',
    ].join('\n'));
    console.log(`\nWrote ${file} for local testing (the public key in it overrides wrangler.toml under wrangler dev).`);
  }
}
