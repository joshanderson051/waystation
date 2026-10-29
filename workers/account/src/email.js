// ============================================================
// PORT SOLACE — account backend: the password-reset email (DESIGN2.md Addendum A2.1, "Forgot your password?")
// The copy for the one email this backend sends, and the two provider adapters it can send it with. Plain
// fetch to a JSON API in both cases; no SDK. Everything here is side-effect free apart from sendEmail.
//
// Environment (wrangler.toml [vars] / `wrangler secret put`)
//   EMAIL_PROVIDER   "resend" (default) or "brevo"
//   EMAIL_FROM       the sender address the provider has approved (Resend: an address on a verified domain,
//                    noreply@portsolace.com; Brevo: a verified sender address). The display name is always "Port Solace".
//   EMAIL_FROM_FALLBACK  optional; Resend only. When Resend refuses EMAIL_FROM because its domain is not verified
//                    (HTTP 403/422), sendEmail retries once from this address (onboarding@resend.dev, Resend's test
//                    sender, which delivers only to the address that owns the Resend account).
//   EMAIL_API_KEY    secret; the provider's API key
//   PLAY_URL         the game's play URL; the reset link is PLAY_URL?reset=<token>
// ============================================================

export const SENDER_NAME = 'Port Solace';
export const RESET_MINUTES = 30;

export const PROVIDERS = {
  resend: {
    name: 'Resend',
    url: 'https://api.resend.com/emails',
    headers: key => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' }),
    body: ({ from, to, subject, text, html }) => ({ from: `${SENDER_NAME} <${from}>`, to: [to], subject, text, html }),
    id: data => data && data.id,
  },
  brevo: {
    name: 'Brevo',
    url: 'https://api.brevo.com/v3/smtp/email',
    headers: key => ({ 'api-key': key, accept: 'application/json', 'content-type': 'application/json' }),
    body: ({ from, to, subject, text, html }) => ({ sender: { name: SENDER_NAME, email: from }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
    id: data => data && data.messageId,
  },
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/;
const trim = v => String(v == null ? '' : v).trim();

// What /health reports and what /forgot checks before it does any work.
export function emailConfig(env = {}) {
  const provider = trim(env.EMAIL_PROVIDER).toLowerCase() || 'resend';
  const from = trim(env.EMAIL_FROM).toLowerCase();
  const fallbackRaw = trim(env.EMAIL_FROM_FALLBACK).toLowerCase();
  const fallback = EMAIL_RE.test(fallbackRaw) ? fallbackRaw : '';   // optional: an invalid one is ignored
  const playUrl = trim(env.PLAY_URL);
  const key = trim(env.EMAIL_API_KEY);
  const missing = [];
  if (!PROVIDERS[provider]) missing.push('EMAIL_PROVIDER');
  if (!EMAIL_RE.test(from)) missing.push('EMAIL_FROM');
  if (!/^https?:\/\/\S+$/.test(playUrl)) missing.push('PLAY_URL');
  if (key.length < 8) missing.push('EMAIL_API_KEY');
  return { provider, from, fallback, playUrl, key, missing, configured: missing.length === 0 };
}

// Resend refuses a sender on a domain that is not (yet) verified with 403 or 422 and a message naming the domain.
export const isUnverifiedSender = (provider, status, message) =>
  provider === 'resend' && (status === 403 || status === 422) && /verif|domain/i.test(String(message || ''));

export const resetLink = (playUrl, token) => `${playUrl}${playUrl.includes('?') ? '&' : '?'}reset=${encodeURIComponent(token)}`;

// ---------------------------------------------------------- the copy (plain text and a simple HTML version)
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function resetEmail({ email, link, playUrl, minutes = RESET_MINUTES }) {
  const subject = 'Reset your Port Solace password';
  const text = [
    'Commander,',
    '',
    `Someone asked for a new password for the Port Solace account at ${email}. If that was you, open this link within ${minutes} minutes and choose one:`,
    '',
    link,
    '',
    'If it was not you, ignore this message. Nothing changes, and the link expires on its own. Your recovery phrase still works as the other way back in.',
    '',
    'Port Solace',
    playUrl || '',
  ].join('\n').trimEnd() + '\n';

  const e = escapeHtml(email), l = escapeHtml(link), p = escapeHtml(playUrl || '');
  const font = "font-family:'Barlow','Segoe UI',Arial,Helvetica,sans-serif;";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#090b12;color:#e6e8ec;${font}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#090b12;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#10141f;border:1px solid #262c3d;border-top:3px solid #e9a23b;border-radius:4px;">
<tr><td style="padding:28px 32px 8px;${font}font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#a3a7b0;">Port Solace &middot; Cloud save</td></tr>
<tr><td style="padding:0 32px 8px;${font}font-size:24px;font-weight:700;color:#ffc46a;">Reset your password</td></tr>
<tr><td style="padding:8px 32px 0;${font}font-size:16px;line-height:1.55;color:#e6e8ec;">Commander,</td></tr>
<tr><td style="padding:12px 32px 0;${font}font-size:16px;line-height:1.55;color:#e6e8ec;">Someone asked for a new password for the Port Solace account at <b style="color:#ffffff;">${e}</b>. If that was you, choose one within ${minutes} minutes:</td></tr>
<tr><td style="padding:24px 32px 8px;" align="left"><a href="${l}" style="display:inline-block;background:#e9a23b;color:#1a1407;${font}font-size:15px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;padding:14px 22px;border-radius:3px;">Set a new password</a></td></tr>
<tr><td style="padding:8px 32px 0;${font}font-size:13px;line-height:1.5;color:#a3a7b0;">If the button does nothing, copy this link into your browser:<br><a href="${l}" style="color:#8fd3e8;word-break:break-all;">${l}</a></td></tr>
<tr><td style="padding:24px 32px 0;${font}font-size:15px;line-height:1.55;color:#a3a7b0;">If it was not you, ignore this message. Nothing changes, and the link expires on its own. Your recovery phrase still works as the other way back in.</td></tr>
<tr><td style="padding:28px 32px 28px;${font}font-size:12px;color:#6b707c;">Port Solace${p ? ` &middot; <a href="${p}" style="color:#6b707c;">${p}</a>` : ''}</td></tr>
</table>
</td></tr>
</table>
</body></html>
`;
  return { subject, text, html };
}

// ---------------------------------------------------------- the send (one call to the provider's API)
// Resolves {ok:true, id, provider, from} or {ok:false, status, error, provider, from}; never throws. `from` is
// the sender address of the attempt reported: EMAIL_FROM, or EMAIL_FROM_FALLBACK when Resend refused EMAIL_FROM
// as unverified and the one retry went out from the fallback. fetchImpl is injectable for the tests.
export async function sendEmail(env, { to, subject, text, html }, fetchImpl) {
  const cfg = emailConfig(env);
  if (!cfg.configured) return { ok: false, status: 0, error: `email not configured: ${cfg.missing.join(', ')}`, provider: cfg.provider, from: cfg.from };
  const P = PROVIDERS[cfg.provider];
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const attempt = async from => {
    let res;
    try {
      res = await doFetch(P.url, { method: 'POST', headers: P.headers(cfg.key), body: JSON.stringify(P.body({ from, to, subject, text, html })) });
    } catch (err) {
      return { ok: false, status: 0, error: `${P.name}: ${(err && err.message) || 'network error'}`, provider: cfg.provider, from };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = data && (data.message || data.error || data.code || data.name);
      return { ok: false, status: res.status, error: `${P.name} answered ${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}`, message: msg ? String(msg) : '', provider: cfg.provider, from };
    }
    return { ok: true, id: P.id(data) || null, provider: cfg.provider, from };
  };
  const strip = ({ message, ...r }) => r;
  const first = await attempt(cfg.from);
  if (first.ok || !cfg.fallback || cfg.fallback === cfg.from || !isUnverifiedSender(cfg.provider, first.status, first.message)) return strip(first);
  return strip(await attempt(cfg.fallback));
}
