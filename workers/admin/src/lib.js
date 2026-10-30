// ============================================================
// PORT SOLACE — Port Authority front door: constants (workers/admin; DESIGN2.md Addendum A9.7)
// Kept apart from index.js because a Worker's main module may only export handlers and functions.
// ============================================================

export const COOKIE = '__Host-ps_admin';
export const SESSION_TTL_S = 12 * 60 * 60;                 // 12 h absolute
export const LOGIN_BODY_MAX = 4 * 1024;
export const PROXY_BODY_MAX = 64 * 1024;
export const SECRET_MIN = 32;
export const CLOCK_SKEW_S = 300;
export const ACCOUNT_BASE = 'https://account.internal';
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
export const COOKIE_RE = /^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{43}$/;
export const PUBLIC_ASSETS = new Set(['/login.js', '/login.css', '/favicon.svg']);
export const PROXY_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const ROBOTS = 'User-agent: *\nDisallow: /\n';

export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
