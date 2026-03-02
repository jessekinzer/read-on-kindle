'use strict';

// ─── Encoding helpers ─────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Base64-encode a string (handles Unicode via UTF-8). */
function encodeAsBase64(str) {
  const b64 = uint8ArrayToBase64(new TextEncoder().encode(str));
  return b64.match(/.{1,76}/g).join('\r\n');
}

/** Base64url-encode a string (URL-safe: no +, /, or = padding). */
function base64UrlEncode(str) {
  return uint8ArrayToBase64(new TextEncoder().encode(str))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ─── MIME construction ────────────────────────────────────────────────────────

/**
 * Build a multipart/mixed RFC 2822 email with the HTML as an attachment.
 * Returns the raw MIME string (not yet base64url-encoded).
 */
function makeMultipartMime(to, subject, htmlString, filename) {
  const boundary = 'kindle_' + Math.random().toString(36).slice(2);
  const htmlBase64 = encodeAsBase64(htmlString);

  return [
    'MIME-Version: 1.0',
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Your Substack article is attached.',
    '',
    `--${boundary}`,
    `Content-Type: text/html; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    htmlBase64,
    '',
    `--${boundary}--`,
  ].join('\r\n');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

const CLIENT_ID = '158487966359-i0h410g6pci951rsreponv7lqph33o39.apps.googleusercontent.com';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/**
 * Get an OAuth token for the user's Gmail account.
 * Tries chrome.identity.getAuthToken first (requires Chrome browser signin),
 * then falls back to launchWebAuthFlow for users who have browser signin off.
 */
function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (!chrome.runtime.lastError) {
        resolve(token);
        return;
      }
      const msg = chrome.runtime.lastError.message || '';
      if (msg.toLowerCase().includes('browser signin') || msg.toLowerCase().includes('not signed in')) {
        getAuthTokenViaWebFlow().then(resolve).catch(reject);
      } else {
        reject(new Error(msg));
      }
    });
  });
}

/**
 * Fallback OAuth flow using launchWebAuthFlow.
 * Works even when Chrome browser signin is disabled.
 */
function getAuthTokenViaWebFlow() {
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl =
    'https://accounts.google.com/o/oauth2/auth' +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    '&response_type=token' +
    `&scope=${encodeURIComponent(GMAIL_SCOPE)}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (redirectUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const match = redirectUrl && redirectUrl.match(/[#&]access_token=([^&]+)/);
      if (!match) {
        reject(new Error('Could not get access token. Please try again.'));
        return;
      }
      resolve(decodeURIComponent(match[1]));
    });
  });
}

// ─── Send ─────────────────────────────────────────────────────────────────────

/**
 * Send an email via the Gmail API with the HTML string as an attachment.
 * @param {string} token  - OAuth bearer token from getAuthToken()
 * @param {string} to     - Recipient email (the Kindle address)
 * @param {string} subject
 * @param {string} htmlString - Full HTML content of the article
 * @param {string} filename   - Attachment filename, e.g. "article-title.html"
 */
async function sendEmail(token, to, subject, htmlString, filename) {
  const mime = makeMultipartMime(to, subject, htmlString, filename);
  const raw = base64UrlEncode(mime);

  const response = await fetch(
    'https://www.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gmail API error ${response.status}`);
  }

  return response.json();
}

// ─── Exports (Node/Jest only — not used in extension context) ─────────────────

if (typeof module !== 'undefined') {
  module.exports = { makeMultipartMime, base64UrlEncode, getAuthToken, sendEmail };
}
