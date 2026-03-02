'use strict';

// ─── Encoding helpers ─────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Base64-encode a string (handles Unicode via UTF-8). */
function encodeAsBase64(str) {
  return uint8ArrayToBase64(new TextEncoder().encode(str));
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

/**
 * Get an OAuth token for the user's Gmail account.
 * Shows the Google consent screen on first call; silent thereafter.
 */
function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
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
