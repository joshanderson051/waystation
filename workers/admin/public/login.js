// ============================================================
// PORT SOLACE — Port Authority sign-in page (DESIGN2.md Addendum A9.7)
// Classic script, vanilla JS, no dependencies, served without a session by workers/admin. Posts the email and
// password to this origin's POST /login; the worker checks them with the account Worker, confirms the account is
// a Port Authority admin and sets an HttpOnly session cookie. This script never sees a token.
// Messages handed over by the portal arrive as ?e=expired | not-admin | signed-out (fixed texts only).
// Every message is rendered through textContent.
// ============================================================
'use strict';

(() => {
  const TIMEOUT_MS = 15000;
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/;
  const NOT_ADMIN = 'This account is not a Port Authority admin.';
  const UNAVAILABLE = 'The sign-in service is unavailable right now. Try again in a minute.';
  const HANDOVER = {
    'expired': { kind: 'warn', word: 'Signed out', text: 'Your sign-in expired. Sign in again.' },
    'not-admin': { kind: 'bad', word: 'Denied', text: NOT_ADMIN },
    'signed-out': { kind: 'good', word: 'Done', text: 'Signed out of Port Authority.' },
  };

  const $ = id => document.getElementById(id);

  function setAlert(m) {
    const box = $('alert');
    box.replaceChildren();
    if (!m) { box.hidden = true; return; }
    box.className = 'notice ' + m.kind;
    const word = document.createElement('span');
    word.className = 'n-word';
    word.textContent = m.word;
    const text = document.createElement('span');
    text.className = 'n-text';
    text.textContent = m.text;
    box.append(word, text);
    box.hidden = false;
  }
  function setError(text, field) {
    const el = $('error');
    el.textContent = text || '';
    el.hidden = !text;
    ['email', 'password'].forEach(id => $(id).removeAttribute('aria-invalid'));
    if (field) { $(field).setAttribute('aria-invalid', 'true'); $(field).focus(); }
  }
  function busy(on) {
    const b = $('submit');
    b.disabled = on;
    b.classList.toggle('busy', on);
    b.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  function waitText(seconds) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  async function submit(ev) {
    ev.preventDefault();
    const email = $('email').value.trim().toLowerCase();
    const password = $('password').value;
    if (!EMAIL_RE.test(email)) return setError('Enter the email address of your Port Solace account.', 'email');
    if (!password) return setError('Enter your password.', 'password');
    setError('');
    setAlert(null);
    busy(true);
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    let res, data = null;
    try {
      res = await fetch('/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      try { data = await res.json(); } catch (e) { data = null; }
    } catch (err) {
      busy(false);
      return setError(err && err.name === 'AbortError' ? 'The sign-in service took too long to answer. Try again.' : 'Could not reach Port Authority. Check the connection and try again.');
    } finally { if (timer) clearTimeout(timer); }

    if (res.ok) {
      $('password').value = '';
      window.location.replace('/');
      return;                                                  // stay busy while the console loads
    }
    busy(false);
    if (res.status === 401) {
      setError('Wrong email or password.', 'password');
      $('password').select();
    } else if (res.status === 403 && data && data.error === 'not-admin') {
      $('password').value = '';
      setAlert({ kind: 'bad', word: 'Denied', text: NOT_ADMIN });
    } else if (res.status === 429) {
      const n = Number(data && data.retryAfter) || Number(res.headers.get('retry-after')) || 60;
      setAlert({ kind: 'warn', word: 'Too many attempts', text: `Try again in ${waitText(n)}.` });
    } else if (res.status === 400) {
      setError('Enter your email and password.', email ? 'password' : 'email');
    } else if (res.status === 403) {
      setAlert({ kind: 'bad', word: 'Refused', text: 'This page could not sign you in. Reload it and try again.' });
    } else {
      setAlert({ kind: 'bad', word: 'Unavailable', text: UNAVAILABLE });
    }
  }

  function boot() {
    let code = '';
    try { code = new URLSearchParams(window.location.search).get('e') || ''; } catch (e) { code = ''; }
    if (Object.prototype.hasOwnProperty.call(HANDOVER, code)) setAlert(HANDOVER[code]);
    if (window.location.search) { try { window.history.replaceState(null, '', '/login'); } catch (e) { /* ignore */ } }
    $('form').addEventListener('submit', submit);
    ['email', 'password'].forEach(id => $(id).addEventListener('input', () => { if (!$('error').hidden) setError(''); }));
    const email = $('email');
    setTimeout(() => (email.value ? $('password') : email).focus(), 30);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
