# Gmail API Send Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the broken mailto-based send with direct Gmail API sending so "Send to Kindle" automatically delivers the article as an HTML email attachment with no manual steps.

**Architecture:** `chrome.identity` acquires an OAuth token for the user's Gmail account. A new `gmail.js` module constructs a multipart MIME email (HTML file as attachment) and POSTs it to the Gmail REST API. `popup.js` calls `gmail.js` instead of the old `sendToKindle` function and shows a "Sent ✓" confirmation state.

**Tech Stack:** Chrome Extensions MV3, `chrome.identity` API, Gmail REST API v1, Jest (unit tests for pure functions)

---

## Task 1: Google Cloud Setup (manual — no code)

This must be done before any OAuth token can be requested. It takes ~5 minutes.

**Step 1: Create a Google Cloud project**

Go to https://console.cloud.google.com → New Project → name it "Substack to Kindle" → Create.

**Step 2: Enable the Gmail API**

Left sidebar → APIs & Services → Library → search "Gmail API" → click it → Enable.

**Step 3: Create OAuth credentials**

APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID.

- Application type: **Chrome Extension**
- Extension ID: open `chrome://extensions` (Developer mode on, Load unpacked if not loaded), copy the ID shown under the extension name
- Paste the extension ID → Create

**Step 4: Copy your client ID**

After creation, copy the **Client ID** string — it looks like:
`123456789012-abc123def456.apps.googleusercontent.com`

You'll paste this into the manifest in Task 2.

**Step 5: Configure OAuth consent screen**

APIs & Services → OAuth consent screen → External → fill in app name ("Substack to Kindle") and your email → Save. Leave it in Testing mode (no need to publish).

**Verify:** You have a client ID string ending in `.apps.googleusercontent.com`.

---

## Task 2: Update manifest.json

**Files:**
- Modify: `manifest.json`

**Step 1: Add identity permission, host_permissions entry, and oauth2 block**

Replace the contents of `manifest.json` with:

```json
{
  "manifest_version": 3,
  "name": "Substack to Kindle",
  "version": "1.0.0",
  "description": "Send Substack articles to your Kindle device via email.",
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "permissions": ["storage", "activeTab", "identity"],
  "host_permissions": [
    "*://*.substack.com/*",
    "https://www.googleapis.com/gmail/v1/"
  ],
  "oauth2": {
    "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "scopes": ["https://www.googleapis.com/auth/gmail.send"]
  },
  "content_scripts": [
    {
      "matches": ["*://*.substack.com/*"],
      "js": ["lib/Readability.js", "content.js"],
      "run_at": "document_idle"
    }
  ],
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

Replace `YOUR_CLIENT_ID` with the client ID from Task 1.

**Step 2: Reload the extension**

Go to `chrome://extensions` → click the refresh icon on the extension. The extension ID must not change — if it does, update the OAuth credential in Google Cloud Console.

**Step 3: Commit**

```bash
git add manifest.json
git commit -m "feat: add identity permission and oauth2 config for Gmail API"
```

---

## Task 3: Set up Jest and write failing tests for gmail.js pure functions

**Files:**
- Create: `tests/gmail.test.js`
- Modify: `package.json` (created by npm init)

**Step 1: Initialize npm and install Jest**

```bash
npm init -y
npm install --save-dev jest
```

**Step 2: Add test script to package.json**

Open `package.json` and add/replace the `"scripts"` block:

```json
"scripts": {
  "test": "jest"
}
```

**Step 3: Write failing tests**

Create `tests/gmail.test.js`:

```javascript
'use strict';

const { makeMultipartMime, base64UrlEncode } = require('../gmail.js');

describe('base64UrlEncode', () => {
  test('produces no +, /, or = characters', () => {
    // Standard base64 uses +, /, = — URL-safe must not
    const result = base64UrlEncode('hello world this is a test string');
    expect(result).not.toMatch(/[+/=]/);
  });

  test('encodes ASCII correctly', () => {
    const input = 'test';
    const encoded = base64UrlEncode(input);
    // Reverse: add padding, swap back to standard base64, decode
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
    const standard = padded.replace(/-/g, '+').replace(/_/g, '/');
    expect(Buffer.from(standard, 'base64').toString('utf8')).toBe(input);
  });
});

describe('makeMultipartMime', () => {
  let result;

  beforeAll(() => {
    result = makeMultipartMime(
      'test@kindle.com',
      'My Article',
      '<html><body>Hello</body></html>',
      'my-article.html'
    );
  });

  test('contains To header', () => {
    expect(result).toContain('To: test@kindle.com');
  });

  test('contains Subject header', () => {
    expect(result).toContain('Subject: My Article');
  });

  test('contains multipart/mixed content type', () => {
    expect(result).toContain('multipart/mixed');
  });

  test('contains attachment filename', () => {
    expect(result).toContain('my-article.html');
  });

  test('contains base64 transfer encoding', () => {
    expect(result).toContain('Content-Transfer-Encoding: base64');
  });

  test('contains attachment disposition', () => {
    expect(result).toContain('Content-Disposition: attachment');
  });

  test('uses CRLF line endings (RFC 2822)', () => {
    expect(result).toContain('\r\n');
  });
});
```

**Step 4: Run tests to verify they fail**

```bash
npm test
```

Expected output: FAIL — `Cannot find module '../gmail.js'`

---

## Task 4: Create gmail.js

**Files:**
- Create: `gmail.js`

**Step 1: Write the implementation**

Create `gmail.js` at the project root:

```javascript
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
```

**Step 2: Run tests to verify they pass**

```bash
npm test
```

Expected output: All 7 tests PASS.

**Step 3: Commit**

```bash
git add gmail.js tests/gmail.test.js package.json package-lock.json
git commit -m "feat: add gmail.js with MIME construction and Gmail API send"
```

---

## Task 5: Add sent state to popup.html and popup.css

**Files:**
- Modify: `popup.html`
- Modify: `popup.css`

**Step 1: Add state-sent div to popup.html**

In `popup.html`, add this block after the closing `</div>` of `id="state-error"` (after line 100), before the `<script>` tags:

```html
  <!-- ── Sent ── -->
  <div id="state-sent" class="state hidden">
    <div class="header">
      <img src="icons/icon48.png" alt="S2K" class="logo">
    </div>
    <p class="sent-msg">Sent to Kindle ✓</p>
    <p class="sent-sub">Check your Kindle in a few minutes.</p>
  </div>
```

Also add `<script src="gmail.js"></script>` **before** the existing `<script src="popup.js"></script>` line, so gmail.js loads first:

```html
  <script src="gmail.js"></script>
  <script src="popup.js"></script>
```

**Step 2: Add styles to popup.css**

Append to the end of `popup.css`:

```css
/* ─── Sent ─── */
.sent-msg {
  font-size: 18px;
  font-weight: 600;
  color: #1a7f37;
  text-align: center;
  margin: 16px 0 6px;
}
.sent-sub {
  font-size: 13px;
  color: #888;
  text-align: center;
}
```

**Step 3: Commit**

```bash
git add popup.html popup.css
git commit -m "feat: add sent confirmation state to popup UI"
```

---

## Task 6: Update popup.js to use Gmail API

**Files:**
- Modify: `popup.js`

### Step 1: Add `sent` to the states object

Find the `states` object (line 13–19). Add a `sent` entry:

```javascript
const states = {
  onboarding: document.getElementById('state-onboarding'),
  main:       document.getElementById('state-main'),
  inactive:   document.getElementById('state-inactive'),
  loading:    document.getElementById('state-loading'),
  error:      document.getElementById('state-error'),
  sent:       document.getElementById('state-sent'),
};
```

### Step 2: Replace the `sendToKindle` function

Delete the old `sendToKindle` function (lines 168–190) and replace it with:

```javascript
async function sendToKindle(htmlString, subject, kindleEmail) {
  const filename = slugify(subject) + '.html';
  showState('loading');
  document.querySelector('.loading-text').textContent = 'Sending…';

  try {
    const token = await getAuthToken();
    await sendEmail(token, kindleEmail, subject, htmlString, filename);
    showState('sent');
  } catch (err) {
    showError(err.message || 'Failed to send. Please try again.', null);
  } finally {
    document.querySelector('.loading-text').textContent = 'Loading article…';
  }
}
```

### Step 3: Update the Send button handler in wireMainButtons

Find the `btnSend.addEventListener` block (around line 272). Replace it with:

```javascript
btnSend.addEventListener('click', async () => {
  if (!currentArticle || !kindleEmail) return;
  const html = formatArticleHtml(currentArticle);
  await sendToKindle(html, currentArticle.title || 'Substack Article', kindleEmail);
});
```

### Step 4: Update the Send Digest button handler in wireMainButtons

Find the `btnSendDigest.addEventListener` block (around line 299). Replace it with:

```javascript
btnSendDigest.addEventListener('click', async () => {
  const queue = await loadQueue();
  if (queue.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const html = formatDigestHtml(queue);
  await sendToKindle(html, `Substack Digest — ${today}`, kindleEmail);
  await saveQueue([]);
});
```

### Step 5: Delete `setActionButtonsDisabled`

Delete the `setActionButtonsDisabled` function (lines 312–317) — it's no longer called anywhere.

### Step 6: Run tests to confirm nothing broke

```bash
npm test
```

Expected: All 7 tests still PASS.

### Step 7: Commit

```bash
git add popup.js
git commit -m "feat: wire Gmail API send into popup, replace mailto fallback"
```

---

## Task 7: Manual end-to-end test

**Prerequisites before testing:**

1. Extension reloaded in `chrome://extensions` after all manifest changes
2. Your Gmail address added to Amazon's approved senders list:
   amazon.com/hz/mycd/myx → Preferences → Personal Document Settings → Approved Personal Document E-mail List → Add your Gmail address

**Test steps:**

1. Open a Substack article (URL like `https://someauthor.substack.com/p/some-article`)
2. Click the extension icon
3. If first time: enter your Kindle email → Save & Continue
4. Click **Send to Kindle**
5. First time only: Google OAuth popup appears
   - Click "Advanced" → "Go to Substack to Kindle (unsafe)" → Allow

**Expected result:**
- Popup shows spinner with "Sending…"
- Popup transitions to "Sent to Kindle ✓" / "Check your Kindle in a few minutes."
- Article appears on your Kindle within 1–5 minutes

**If something goes wrong:**
- Right-click the popup → Inspect → Console tab for JS errors
- Check that `client_id` in manifest matches what Google Cloud Console shows
- Verify your Gmail is on Amazon's approved senders list
- Try revoking and re-granting the OAuth token: go to myaccount.google.com/permissions → remove "Substack to Kindle" → click Send again
