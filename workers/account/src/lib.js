// ============================================================
// WAYSTATION — account backend: constants and pure helpers (DESIGN2.md Addendum A2.1)
// Kept apart from index.js because a module Worker's main file may only export handlers and functions
// (workerd rejects exported constants at start-up). Everything here is side-effect free and unit-tested.
// ============================================================

export const PBKDF2_ITER = 210000;
export const SALT_BYTES = 16;
export const TOKEN_BYTES = 32;
export const TOKEN_TTL_S = 30 * 24 * 3600;             // A2.1: sliding 30 days
export const TOKEN_REFRESH_MS = 6 * 3600e3;           // slide the TTL at most every 6 h (KV writes are the scarce resource)
export const SAVE_MAX_BYTES = 1024 * 1024;            // A2.1: profile JSON capped at 1 MB
export const BODY_MAX_BYTES = SAVE_MAX_BYTES + 64 * 1024;   // wrapper + slack; the profile itself is measured after parsing
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;
export const PHRASE_WORDS = 10;
export const LIMITS = {                               // A2.1: per-IP rate limits
  signup:  { max: 10, windowS: 3600 },
  login:   { max: 20, windowS: 600 },
  recover: { max: 5,  windowS: 3600 },
};
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/;
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

// 512 short, distinct, lower-case words for recovery phrases (ten words = 90 bits).
export const WORDS = `
orbit comet nova pulsar quasar nebula planet rocket lunar solar cosmic galaxy meteor photon plasma vacuum
anchor harbor beacon bridge cargo deck dock engine flight gate hangar hatch helm hull keel lantern
mast pilot radar relay rudder sail signal sonar thrust tower trail truss valve vector wharf zenith
acorn amber aspen birch cedar clover coral cotton daisy delta dune ember fern forest garden glade
granite gravel grove harvest hazel heather holly iris ivory ivy jade jasper juniper kelp lagoon laurel
lily linen lotus maple marble meadow mint moss oak olive onyx orchid pebble pine poppy quartz
reed ridge river rose sage sand shore silver slate spruce stone summit thyme tulip tundra valley
willow wheat yarrow zephyr basil bamboo cactus canyon cliff crystal desert fjord geyser glacier island jungle
badger beaver bison camel condor cougar crane dolphin eagle falcon ferret finch gecko gull heron hornet
ibis jackal koala lemur lizard lobster lynx magpie marlin moose newt osprey otter owl panda parrot
pelican penguin puffin python rabbit raven robin salmon seal shark swift spider squid swan tiger toucan
trout turtle walrus wasp weasel whale wolf wombat yak zebra ant bat bear cod crab crow
anvil arrow axle banner barrel basket bell blade bolt bottle brush bucket button cable candle canvas
chain chisel clock compass crate cup dial drum easel fabric feather flask fork frame funnel glove
hammer handle hinge hook jar kettle key kite knot ladder lamp latch lens lever magnet mallet
crayon mirror needle net oar paddle pencil pillow pin pipe pitcher board pocket pulley quill ribbon
ring rope saddle scale scoop shovel sickle spade bobbin spoon stamp string tape thread tile timber
token tongs torch tray trowel trumpet violin wagon wheel whistle wick wire wrench yarn zipper bagel
apple apricot bean berry biscuit butter cabbage carrot cashew celery cherry cocoa coffee cookie corn cream
fig garlic ginger grape honey lemon lentil lime mango melon muffin noodle nutmeg oat onion orange
guava peach pear pepper pickle plum potato pumpkin radish raisin rice salad sugar tomato vanilla walnut
abbey arena attic bistro balcony barn castle cellar chapel cabin chalet depot farm forge fort garage
gallery gym hostel inn kiosk library lodge market mill museum office vineyard palace pantry parlor pier
plaza porch canal ranch school shed stable studio temple tavern theater vault manor village workshop zoo
actor admiral artist baker barber butler captain carver clerk coach courier dancer doctor driver fisher fencer
guard guide hunter jester judge knight mayor medic miner monk nurse painter pilgrim poet porter ranger
skipper scribe scout sheriff singer smith soldier surgeon tailor tanner teacher tutor usher weaver writer yeoman
azure beige bronze cobalt copper crimson gold indigo khaki lilac maroon navy ochre mauve purple ruby
saffron scarlet sepia teal lavender yellow autumn dawn dusk frost mist monsoon rain shadow snow spring
storm august sunset thunder tide breeze winter cloud flame flood fog hail spark wind ice smoke
alpha bravo echo foxtrot golf hotel ionic juliet kilo ledger mike oscar papa romeo sierra tango
uniform victor xray yankee zulu atlas argon carbon helium iron krypton neon nickel oxygen radon sodium
`.trim().split(/\s+/);

export class HttpError extends Error {
  constructor(status, code, message, extra, headers) {
    super(message);
    this.status = status; this.code = code; this.extra = extra || {}; this.headers = headers || {};
  }
}

// ---------------------------------------------------------- bytes and encoding
const te = new TextEncoder(), td = new TextDecoder();
export const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64u(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
export const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const decodeUtf8 = bytes => td.decode(bytes);
export const utf8Length = text => te.encode(text).byteLength;

export async function sha256Hex(text) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(text)))); }

// ---------------------------------------------------------- PBKDF2-SHA256 over `${secret}${pepper}` (A2.1)
export async function derive(secret, pepper, salt, iter = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey('raw', te.encode(String(secret) + String(pepper)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}
export async function hashSecret(secret, pepper) {
  const salt = randomBytes(SALT_BYTES);
  return { salt: b64u(salt), hash: b64u(await derive(secret, pepper, salt, PBKDF2_ITER)), iter: PBKDF2_ITER };
}
export async function verifySecret(secret, pepper, rec) {
  if (!rec || typeof rec.salt !== 'string' || typeof rec.hash !== 'string') return false;
  const got = b64u(await derive(secret, pepper, unb64u(rec.salt), Number(rec.iter) || PBKDF2_ITER));
  return timingSafeEqual(got, rec.hash);
}
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------- recovery phrases and ids
// Ten words from WORDS; compared after normalisation (case, punctuation and spacing do not matter).
export function makePhrase() {
  const idx = crypto.getRandomValues(new Uint16Array(PHRASE_WORDS));
  return Array.from(idx, i => WORDS[i % WORDS.length]).join(' ');
}
export const normalisePhrase = s => String(s || '').toLowerCase().split(/[^a-z]+/).filter(Boolean).join(' ');
export const newId = () => 'u_' + b64u(randomBytes(12));

// ---------------------------------------------------------- request bodies and validation
// Accepts a plain or gzip-compressed body (sniffed by magic bytes; the client compresses large saves so the
// pagehide keepalive push fits the browser's 64 KB keepalive budget). Caps both the wire and the inflated size.
export async function readBodyBytes(request, max) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > max) throw new HttpError(413, 'too-large', `The request body may not exceed ${max} bytes.`, { max });
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > max) throw new HttpError(413, 'too-large', `The request body may not exceed ${max} bytes.`, { max });
  if (raw.length < 2 || raw[0] !== 0x1f || raw[1] !== 0x8b) return raw;
  const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new HttpError(413, 'too-large', `The request body may not exceed ${max} bytes.`, { max }); }
    chunks.push(value);
  }
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}
export function requireEmail(v) {
  const e = String(v == null ? '' : v).trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 254) throw new HttpError(400, 'bad-email', 'Enter a valid email address.');
  return e;
}
export function requirePassword(v, field = 'password') {
  if (typeof v !== 'string' || v.length < PASSWORD_MIN) throw new HttpError(400, 'weak-password', `The ${field} must be at least ${PASSWORD_MIN} characters.`, { min: PASSWORD_MIN });
  if (v.length > PASSWORD_MAX) throw new HttpError(400, 'bad-password', `The ${field} may not exceed ${PASSWORD_MAX} characters.`);
  return v;
}

// ---------------------------------------------------------- the cloud save summary (mirrored in play/js/account.js)
export function summarise(p) {
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const sectors = p && p.sectors && typeof p.sectors === 'object' && !Array.isArray(p.sectors) ? p.sectors : {};
  const active = p && typeof p.activeSector === 'string' && sectors[p.activeSector] && typeof sectors[p.activeSector] === 'object' ? sectors[p.activeSector] : null;
  let best = 0;
  for (const id in sectors) if (sectors[id] && typeof sectors[id] === 'object') best = Math.max(best, Math.floor(num(sectors[id].level)));
  const unlocked = p && Array.isArray(p.unlocked) ? p.unlocked.length : 0;
  return {
    name: String(active && active.name ? active.name : 'Unnamed station').slice(0, 40),
    day: Math.max(0, Math.floor(num(active && active.day))),
    level: Math.max(1, active ? Math.floor(num(active.level)) || best || 1 : best || 1),
    credits: Math.round(num(p && p.credits != null ? p.credits : active && active.credits)),
    am: Math.round(num(p && p.am)),
    sectors: Math.max(unlocked, Object.keys(sectors).length, 0),
    rank: Math.max(1, Math.floor(num(p && p.rank && p.rank.level)) || 1),
  };
}
