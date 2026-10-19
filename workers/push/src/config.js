// ============================================================
// WAYSTATION — push worker: shared constants
// Kept out of src/index.js because the Workers runtime only accepts functions and handlers as named exports
// of the entry module; the tests import these from here.
// ============================================================
export const KINDS = ['build', 'upgrade', 'expedition', 'plot', 'daily', 'test'];   // test: "Send a test notification" in Settings
export const MAX_TIMERS = 64;                 // per player; the client sends the soonest ones
export const STALE_MS = 2 * 3600e3;           // a timer this long past due is forgotten, not announced
export const PAST_GRACE_MS = 10 * 60e3;       // /schedule keeps timers up to this far in the past (clock skew, a tab closing late)
export const FUTURE_LIMIT_MS = 400 * 86400e3;
export const MAX_SENDS_PER_RUN = 40;          // the free plan allows 50 subrequests per invocation; the rest go next minute
export const HEAL_EVERY_MIN = 15;             // rebuild `index` from the timers: keys every N minutes
export const DEFAULT_SUBJECT = 'https://joshanderson051.github.io/waystation/';
export const KEY_INDEX = 'index';
export const TTL_S = 24 * 3600;               // how long a push service holds a message for an offline device
export const TOPIC = 'waystation';            // a newer message replaces an undelivered older one
export const MAX_BODY_BYTES = 32 * 1024;
