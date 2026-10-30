'use strict';

// Gmail helpers: MIME construction, OAuth token handling, and the send call.
// Loaded by the service worker (background.js) via importScripts, and by Jest via require.

// ─── Encoding helpers ─────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Base64-encode a string (handles Unicode via UTF-8), folded at 76 chars per RFC 2045. */
function encodeAsBase64(str) {
  const b64 = uint8ArrayToBase64(new TextEncoder().encode(str));
  return (b64.match(/.{1,76}/g) || ['']).join('\r\n');
}

/** Base64url-encode a string (URL-safe: no +, /, or = padding). */
function base64UrlEncode(str) {
  return uint8ArrayToBase64(new TextEncoder().encode(str))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Remove CR/LF so a value can never inject extra MIME headers. */
function headerSafe(str) {
  return String(str || '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Encode a header value per RFC 2047 when it contains non-ASCII characters
 * (em dashes, curly quotes, accented names), so Gmail and Kindle show it intact.
 * Long values are split into several encoded words of at most 75 characters
 * each (the RFC 2047 limit), folded onto continuation lines, and never split
 * inside a character.
 */
function encodeHeaderValue(str) {
  const clean = headerSafe(str);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  const encoder = new TextEncoder();
  const MAX_BYTES = 45; // 45 bytes -> 60 base64 chars -> a 72-char encoded word
  const words = [];
  let chunk = '';
  for (const ch of clean) {
    if (chunk && encoder.encode(chunk + ch).length > MAX_BYTES) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words
    .map((w) => `=?UTF-8?B?${uint8ArrayToBase64(encoder.encode(w))}?=`)
    .join('\r\n ');
}

// ─── MIME construction ────────────────────────────────────────────────────────

/**
 * Build a multipart/mixed RFC 2822 email with the HTML as an attachment.
 * Returns the raw MIME string. Every line is ASCII.
 */
function makeMultipartMime(to, subject, htmlString, filename) {
  const boundary = 'kindle_' + Math.random().toString(36).slice(2);
  const htmlBase64 = encodeAsBase64(htmlString);
  const safeName = headerSafe(filename).replace(/"/g, '') || 'article.html';

  return [
    'MIME-Version: 1.0',
    `To: ${headerSafe(to)}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Your article is attached.',
    '',
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"; name="${safeName}"`,
    `Content-Disposition: attachment; filename="${safeName}"`,
    'Content-Transfer-Encoding: base64',
    '',
    htmlBase64,
    '',
    `--${boundary}--`,
  ].join('\r\n');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Two ways to get a Gmail token:
//   1. chrome.identity.getAuthToken: Google Chrome's own account sign-in, with
//      the manifest's "Chrome extension" OAuth client. Smoothest, but only in
//      Google Chrome with Chrome sign-in on. Other Chromium browsers (Comet,
//      Brave, Edge, Arc, Chromium) have no Chrome account and always fail.
//   2. chrome.identity.launchWebAuthFlow: Google's sign-in page in a window,
//      with a "Web application" OAuth client whose authorized redirect URI is
//      chrome.identity.getRedirectURL() (https://<extension-id>.chromiumapp.org/).
//      It uses the implicit flow (response_type=token): a web client needs a
//      client secret to exchange an authorization code, and no secret can ship
//      inside an extension. The token lasts about an hour; it is cached in
//      chrome.storage.session (memory only) and renewed silently (prompt=none
//      with the remembered account) before the sign-in window is shown again.

// Web application OAuth client for the launchWebAuthFlow sign-in. Create it in
// Google Cloud Console (APIs & Services, Credentials, OAuth client ID, type
// "Web application") with the redirect URI https://<extension-id>.chromiumapp.org/
// and paste its client ID here.
const WEB_OAUTH_CLIENT_ID = '158487966359-mp7pr16437sth2fhgadduaat02tbn1o0.apps.googleusercontent.com';

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
// openid + email give back the account's address, used only as a login hint
// so a later sign-in can happen silently with the same account.
const WEB_SCOPES = ['openid', 'email', GMAIL_SEND_SCOPE];
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const AUTH_STATE_KEY = 'gmailAuth'; // chrome.storage.local: { method: 'web', loginHint }
const TOKEN_CACHE_KEY = 'gmailToken'; // chrome.storage.session: { token, expiresAt }
const EXPIRY_MARGIN_MS = 60 * 1000; // renew a minute early
const SILENT_TIMEOUT_MS = 10000;

function authError(message, code) {
  return Object.assign(new Error(message), code ? { code } : {});
}

function isWebClientConfigured(clientId) {
  return typeof clientId === 'string' && /\.apps\.googleusercontent\.com$/.test(clientId) && !/REPLACE_WITH/.test(clientId);
}

/** The user said no (closed the window or pressed Cancel): never ask a second way. */
function isUserCancel(err) {
  return err && (err.code === 'cancelled'
    || /did not approve|cancel|closed by the user|access_denied/i.test(err.message || ''));
}

/**
 * False only when the browser says it is something other than Google Chrome
 * (Comet, Edge, Brave, Opera...). When it can't tell, Chrome's own sign-in is
 * tried first, and its failure leads to the web sign-in anyway.
 */
function isGoogleChrome(nav = typeof navigator !== 'undefined' ? navigator : null) {
  const brands = nav && nav.userAgentData && nav.userAgentData.brands;
  if (!Array.isArray(brands) || brands.length === 0) return true;
  return brands.some((b) => b && b.brand === 'Google Chrome');
}

async function storageGet(area, key) {
  try {
    const store = chrome.storage && chrome.storage[area];
    if (!store) return undefined;
    return (await store.get([key]))[key];
  } catch (_) {
    return undefined;
  }
}

async function storageSet(area, value) {
  try {
    const store = chrome.storage && chrome.storage[area];
    if (store) await store.set(value);
  } catch (_) { /* caching is best effort */ }
}

async function storageRemove(area, key) {
  try {
    const store = chrome.storage && chrome.storage[area];
    if (store) await store.remove(key);
  } catch (_) { /* best effort */ }
}

/** Google Chrome's own sign-in (the Chrome account). */
function chromeAccountToken() {
  return new Promise((resolve, reject) => {
    if (!chrome.identity || typeof chrome.identity.getAuthToken !== 'function') {
      reject(authError('getAuthToken is not available in this browser.', 'unsupported'));
      return;
    }
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      const lastError = chrome.runtime.lastError;
      if (!lastError && token) {
        resolve(typeof token === 'string' ? token : token.token);
        return;
      }
      const err = authError((lastError && lastError.message) || 'Could not get a Gmail sign-in token.');
      if (/browser ?sign-?in/i.test(err.message)) err.code = 'signin_off';
      reject(err);
    });
  });
}

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The payload of a JWT, unverified: only used to read the account's email as a login hint. */
function jwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(part + '='.repeat((4 - (part.length % 4)) % 4)), (c) => c.charCodeAt(0)));
    return JSON.parse(json);
  } catch (_) {
    return {};
  }
}

function launchWebAuthFlow(details) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(details, (responseUrl) => {
      const lastError = chrome.runtime.lastError;
      if (lastError || !responseUrl) {
        reject(authError((lastError && lastError.message) || 'Google sign-in did not finish.'));
        return;
      }
      resolve(responseUrl);
    });
  });
}

/** One run of Google's sign-in page. Returns { token, expiresAt, loginHint }. */
async function runWebFlow({ clientId, loginHint, interactive }) {
  const state = randomToken();
  const nonce = randomToken();
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', chrome.identity.getRedirectURL());
  url.searchParams.set('response_type', 'token id_token');
  url.searchParams.set('scope', WEB_SCOPES.join(' '));
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  if (!interactive) url.searchParams.set('prompt', 'none');

  let responseUrl;
  try {
    responseUrl = await launchWebAuthFlow({
      url: url.href,
      interactive,
      // Google may finish a silent sign-in after the page loads.
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: SILENT_TIMEOUT_MS,
    });
  } catch (err) {
    if (interactive && /did not approve|closed|cancel/i.test(err.message)) err.code = 'cancelled';
    throw err;
  }

  const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
  if (params.get('state') !== state) {
    throw authError('Google sign-in could not be verified (state mismatch).', 'state_mismatch');
  }
  const error = params.get('error');
  if (error === 'access_denied') throw authError('The user did not approve access.', 'cancelled');
  if (error) throw authError(`Google sign-in failed: ${error}.`, /required$/.test(error) ? 'interaction_required' : 'auth_failed');

  const token = params.get('access_token');
  if (!token) throw authError('Google sign-in returned no access token.', 'auth_failed');
  const granted = (params.get('scope') || '').split(/\s+/);
  if (params.get('scope') && !granted.includes(GMAIL_SEND_SCOPE)) {
    throw authError('Request had insufficient authentication scopes.', 'insufficient_scope');
  }
  const idToken = params.get('id_token');
  const claims = idToken ? jwtPayload(idToken) : {};
  if (idToken && claims.nonce !== nonce) {
    throw authError('Google sign-in could not be verified (nonce mismatch).', 'state_mismatch');
  }
  const expiresIn = parseInt(params.get('expires_in'), 10) || 3600;
  return {
    token,
    expiresAt: Date.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS,
    loginHint: claims.email || claims.sub || loginHint || '',
  };
}

/**
 * Web sign-in: a cached token if it is still fresh; else a silent renewal with
 * the remembered account; else Google's sign-in window.
 */
async function webAuthToken(clientId) {
  if (!isWebClientConfigured(clientId)) {
    throw authError('The web sign-in client is not configured.', 'web_auth_unconfigured');
  }
  const saved = (await storageGet('local', AUTH_STATE_KEY)) || {};
  let result = null;
  if (saved.loginHint) {
    try {
      result = await runWebFlow({ clientId, loginHint: saved.loginHint, interactive: false });
    } catch (_) {
      result = null; // needs the user (signed out, consent changed): ask interactively
    }
  }
  if (!result) result = await runWebFlow({ clientId, loginHint: saved.loginHint, interactive: true });
  await storageSet('session', { [TOKEN_CACHE_KEY]: { token: result.token, expiresAt: result.expiresAt } });
  await storageSet('local', { [AUTH_STATE_KEY]: { method: 'web', loginHint: result.loginHint } });
  return result.token;
}

/**
 * Get a Gmail token. Google Chrome's own sign-in is tried first (unless this
 * browser is known not to be Google Chrome, or the web sign-in already worked
 * here); any failure other than the user saying no falls back to the web
 * sign-in. opts.clientId overrides WEB_OAUTH_CLIENT_ID (tests).
 */
async function getAuthToken(opts = {}) {
  const { clientId = WEB_OAUTH_CLIENT_ID, nav } = opts;
  const cached = await storageGet('session', TOKEN_CACHE_KEY);
  if (cached && cached.token && cached.expiresAt > Date.now()) return cached.token;

  const saved = (await storageGet('local', AUTH_STATE_KEY)) || {};
  if (saved.method !== 'web' && isGoogleChrome(nav)) {
    try {
      return await chromeAccountToken();
    } catch (err) {
      if (isUserCancel(err)) throw err;
      // No Chrome account (sign-in off, unsupported browser, client mismatch): use the web sign-in.
    }
  }
  return webAuthToken(clientId);
}

/** Drop a token that Gmail rejected, so the next getAuthToken gets a fresh one. */
async function removeCachedAuthToken(token) {
  const cached = await storageGet('session', TOKEN_CACHE_KEY);
  if (cached && (!token || cached.token === token)) await storageRemove('session', TOKEN_CACHE_KEY);
  await new Promise((resolve) => {
    if (!token || !chrome.identity || !chrome.identity.removeCachedAuthToken) { resolve(); return; }
    chrome.identity.removeCachedAuthToken({ token }, () => {
      void chrome.runtime.lastError; // nothing useful to do with a failure here
      resolve();
    });
  });
}

// ─── Send ─────────────────────────────────────────────────────────────────────

// Media upload endpoint: takes the raw RFC 822 message directly (no base64url
// re-encoding of the whole message) and accepts messages up to 35 MB.
const GMAIL_SEND_URL =
  'https://www.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';

/**
 * Send an email via the Gmail API with the HTML string as an attachment.
 * Throws an Error with a `status` property when Gmail answers with an HTTP error.
 * @param {string} token  - OAuth bearer token from getAuthToken()
 * @param {string} to     - Recipient email (the Kindle address)
 * @param {string} subject
 * @param {string} htmlString - Full HTML content of the article
 * @param {string} filename   - Attachment filename, e.g. "Article Title.html"
 * @param {{timeoutMs?: number, fetchFn?: Function}} [opts]
 */
async function sendEmail(token, to, subject, htmlString, filename, opts = {}) {
  const mime = makeMultipartMime(to, subject, htmlString, filename);
  // 2 minutes plus 10 seconds per MB, so a large digest on a slow uplink is not
  // cut off mid-upload; capped below the service worker's 5-minute limit.
  const sizeMb = mime.length / (1024 * 1024);
  const { timeoutMs = Math.min(120000 + sizeMb * 10000, 280000), fetchFn = fetch } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchFn(GMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'message/rfc822',
      },
      body: mime,
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const timeoutErr = new Error('Gmail request timed out.');
      timeoutErr.code = 'timeout';
      throw timeoutErr;
    }
    const netErr = new Error((err && err.message) || 'Network request failed.');
    netErr.code = 'network';
    throw netErr;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const err = new Error((body.error && body.error.message) || `Gmail API error ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return response.json().catch(() => ({}));
}

// ─── Exports (Node/Jest only, not used in extension context) ──────────────────

if (typeof module !== 'undefined') {
  module.exports = {
    uint8ArrayToBase64,
    encodeHeaderValue,
    makeMultipartMime,
    base64UrlEncode,
    getAuthToken,
    removeCachedAuthToken,
    isGoogleChrome,
    isWebClientConfigured,
    WEB_OAUTH_CLIENT_ID,
    sendEmail,
    GMAIL_SEND_URL,
  };
}
