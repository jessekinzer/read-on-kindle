# Design: Gmail API Send

**Date:** 2026-03-01
**Status:** Approved

## Problem

The current `sendToKindle()` function uses `mailto:` links. For any real Substack article (always > 1800 encoded chars), it silently downloads an HTML file and opens the mail client with no body and no attachment. The user sees an empty email with no guidance — they send it empty, Kindle receives nothing.

## Solution

Replace the `mailto:` approach with direct Gmail API sending via `chrome.identity`. The extension gets an OAuth token for the user's Gmail account and sends the email with the HTML article as an attachment — no manual steps, no server required.

## Architecture

### One-time Google Cloud setup (manual, by developer)

1. Create a project at console.cloud.google.com
2. Enable the Gmail API
3. Create an OAuth 2.0 credential — type **Chrome Extension**, paste the extension's ID
4. Set scope: `https://www.googleapis.com/auth/gmail.send`
5. Copy the `client_id` into the manifest

### Manifest changes

```json
{
  "permissions": ["storage", "activeTab", "identity"],
  "host_permissions": [
    "*://*.substack.com/*",
    "https://www.googleapis.com/gmail/v1/"
  ],
  "oauth2": {
    "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "scopes": ["https://www.googleapis.com/auth/gmail.send"]
  }
}
```

### New file: `gmail.js`

Two exported functions:

**`getAuthToken()`**
Calls `chrome.identity.getAuthToken({ interactive: true })`. Chrome handles the OAuth popup (first use only), token storage, and refresh automatically. Returns a bearer token string.

**`sendEmail(token, to, subject, htmlString, filename)`**
- Constructs a `multipart/mixed` MIME email (RFC 2822)
- Attaches the HTML as `Content-Type: text/html` with `Content-Disposition: attachment`
- Base64url-encodes the full message
- POSTs to `https://www.googleapis.com/gmail/v1/users/me/messages/send` with `Authorization: Bearer <token>`

The email is sent from the user's own Gmail address — which is the address they need to add to Amazon's approved senders list.

### `popup.js` changes

Replace `sendToKindle()` with an async version:

1. Show "Sending…" loading state in popup
2. Call `getAuthToken()` — triggers OAuth consent screen on first use, silent thereafter
3. Call `sendEmail()` with the formatted HTML and kindle email
4. On success: show "Sent to Kindle ✓" confirmation in popup
5. On error: show error state with retry option

Remove the existing download-based fallback entirely.

## UX Flow (after change)

1. User clicks "Send to Kindle" → spinner appears
2. First time only: Google OAuth consent popup → user approves once
3. Email sent automatically with `.html` attachment
4. Popup shows "Sent to Kindle ✓"

## Error cases

- **Token denied/revoked:** Show error with "Re-authorize" retry
- **Gmail API error (4xx/5xx):** Show error message with retry
- **Network offline:** Show error with retry

## Constraints

- Gmail users only (not Apple Mail, Outlook, etc.)
- User's Gmail address must be on Amazon's approved senders list
- OAuth app will show "unverified" warning on first auth — acceptable for a developer/personal tool
