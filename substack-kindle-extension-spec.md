# Substack to Kindle — Chrome Extension Build Spec

## Project Overview

Build a Chrome browser extension that allows a user to send any Substack article they are currently reading directly to their Kindle device. The extension also supports a queue mode, where the user can collect multiple articles and send them together as a single digest document. The entire extension runs client-side — no backend server is required for v1.

---

## Core User Flows

### Flow 1: Send Current Article Immediately

1. User is reading a Substack article in Chrome.
2. User clicks the extension icon in the Chrome toolbar.
3. A small popup appears showing the detected article title and author.
4. User clicks **"Send to Kindle"**.
5. The extension extracts the article content from the page, formats it, and triggers an email to the user's saved Kindle address.
6. A confirmation message appears in the popup.

### Flow 2: Add to Queue, Send as Digest

1. User is reading a Substack article.
2. User clicks the extension icon.
3. User clicks **"Add to Queue"** instead of sending immediately.
4. The popup shows a running count of queued articles (e.g. "3 articles in queue").
5. When the user is ready, they click **"Send Queue as Digest"**.
6. All queued articles are compiled into a single formatted document and sent to their Kindle address.
7. The queue clears after sending.

### Flow 3: First-Time Onboarding

1. User installs the extension.
2. On first click, the popup shows an onboarding screen instead of the main UI.
3. User is prompted to enter their Kindle email address (format: `name@kindle.com`).
4. A clearly worded instruction with a direct link walks the user through adding the approved sender email to their Amazon account. The approved sender they need to add is their own email address (the one they'll be sending from via their mail client).
5. User saves their Kindle address. Onboarding is complete and never shown again.

---

## File Structure

```
substack-kindle/
├── manifest.json
├── popup.html
├── popup.js
├── popup.css
├── content.js
├── background.js (minimal, only if needed)
├── lib/
│   └── Readability.js        ← Mozilla's open source library
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## File Descriptions and Responsibilities

### `manifest.json`

- Manifest version: **3** (required by Chrome)
- Permissions needed:
  - `activeTab` — to read the content of the current tab when the user clicks the extension
  - `storage` — to save the user's Kindle email address and article queue across sessions
  - `scripting` — to inject the content script and run Readability on the page
- Host permissions: `*://*.substack.com/*` — restrict the extension to only work on Substack pages
- Define the popup as `popup.html`
- Define icons

### `content.js`

This script is injected into the active Substack tab when the user interacts with the extension. Its sole job is to extract clean article content from the page DOM.

- Import and run **Readability.js** on `document.cloneNode(true)`
- Return a structured object containing:
  - `title` — article headline
  - `byline` — author name
  - `content` — clean HTML body of the article (stripped of nav, footers, comments, recommended posts)
  - `url` — the canonical URL of the article
  - `date` — publication date if detectable from the DOM
- This script should only run when explicitly invoked by the popup (not automatically on page load)

### `popup.html` + `popup.css`

The UI that appears when the user clicks the extension icon. It should be clean and minimal — approximately 320px wide.

States to design:

**Onboarding state** (first time only):
- Heading: "Set up your Kindle address"
- Input field for Kindle email
- Step-by-step instructions for adding approved sender to Amazon
- Clickable link to Amazon's approved sender settings page: `https://www.amazon.com/hz/mycd/myx#/home/settings/payment`
- Save button

**Main state** (after onboarding):
- Article title and author detected from current page (or a message like "Open a Substack article to get started" if not on a Substack page)
- Two buttons: **Send to Kindle** and **Add to Queue**
- Queue count indicator: "X articles in queue" with a **Send Digest** button visible when queue has 1 or more articles
- Small settings icon/link to update Kindle address

**Loading state**:
- Simple spinner or "Sending..." text while processing

**Success state**:
- Confirmation message: "Sent to your Kindle!" or "Digest sent — X articles"
- Auto-dismisses or shows a reset button

**Error state**:
- Clear error message if something goes wrong (e.g. "Couldn't detect article content" or "Not a Substack page")

### `popup.js`

Handles all logic for the popup. Key responsibilities:

**On popup open:**
- Check Chrome storage for saved Kindle email — if none, show onboarding state
- Check if current tab URL matches `*.substack.com/*` — if not, show inactive state
- Send a message to `content.js` to extract article data from the current tab
- Display the returned article title and author in the popup

**On "Send to Kindle" click:**
- Retrieve extracted article content
- Format it as clean HTML (see Formatting section below)
- Trigger the email send method (see Sending section below)
- Show success/error state

**On "Add to Queue" click:**
- Save the current article's extracted content object to Chrome local storage
- Update the queue count display

**On "Send Digest" click:**
- Retrieve all queued articles from Chrome storage
- Compile them into a single formatted HTML document with a cover section listing all titles
- Trigger the email send method
- Clear the queue from storage
- Show success state

**On settings:**
- Allow user to update their saved Kindle email address

### `lib/Readability.js`

Use the official Mozilla Readability library. Source it from: `https://github.com/mozilla/readability`

Download `Readability.js` and bundle it locally inside the extension — do not load it from a CDN, as Chrome extensions require local bundling of scripts.

---

## Content Formatting

When preparing content to send to Kindle, format the extracted article as a self-contained HTML document with inline styles (Kindle renders inline styles most reliably):

```
- Font: Georgia or serif fallback
- Font size: 16px body, 24px title, 14px byline/date
- Max width: 600px, centered
- Line height: 1.6
- Images: max-width 100%
- Include title, byline, date, source URL, and then article body
- For digests: include a simple table of contents at the top, then each article separated by a horizontal rule
```

---

## Sending Method

Use the **mailto: approach** for v1. This requires no backend, no API keys, and no server.

How it works:
- Construct a `mailto:` link addressed to the user's Kindle email
- Set subject to the article title (or "Your Substack Digest — [date]" for digests)
- The article HTML goes in the email body
- Use `window.open('mailto:...')` to trigger the user's default mail client with the email pre-composed
- User hits send in their mail client — one click

Limitations to note in the UI:
- This opens the user's default email client (Mail, Outlook, Gmail desktop app, etc.)
- It does not work with browser-based Gmail or other webmail unless set as default mail handler
- Add a small note in the success/info UI: "Your mail app will open — just hit send"

Alternative (optional, for future enhancement): integrate with EmailJS or a similar client-side email sending service that allows sending without a backend. This would allow fully silent sending without opening a mail client.

---

## Chrome Storage Schema

Use `chrome.storage.local` for all persistence.

```json
{
  "kindleEmail": "username@kindle.com",
  "onboardingComplete": true,
  "queue": [
    {
      "title": "Article Title",
      "byline": "Author Name",
      "date": "March 1, 2026",
      "url": "https://publication.substack.com/p/article-slug",
      "content": "<p>Clean HTML article body...</p>"
    }
  ]
}
```

---

## Edge Cases to Handle

- User clicks extension when not on a Substack page — show friendly inactive state, not an error
- Readability fails to extract content (paywalled article the user isn't subscribed to, or unusual page structure) — show a clear message: "Couldn't read this article. Make sure you're subscribed and the full article is loaded."
- Kindle email not yet saved — always redirect to onboarding before any send action
- Queue is empty when user tries to send digest — disable the Send Digest button
- Article already in queue — optionally detect by URL and show "Already in queue" rather than adding a duplicate
- Very long articles — no special handling needed, Kindle handles long documents fine

---

## Onboarding UX — Approved Sender Setup

This is the one external dependency the user must configure. Make it as painless as possible.

In the onboarding screen, explain:
> "To receive articles on your Kindle, Amazon requires that emails come from an address you've approved. You'll send articles from your own email app, so you need to add your personal email address to your Amazon approved list."

Steps to show the user:
1. Go to **Amazon → Account → Manage Your Content and Devices → Preferences → Personal Document Settings**
2. Under **Approved Personal Document E-mail List**, click **Add a new approved e-mail address**
3. Add the email address you use in your mail app (the one that will send the mailto)
4. Click **Add Address**

Provide a direct link button: **"Open Amazon Settings →"** pointing to `https://www.amazon.com/hz/mycd/myx#/home/settings/payment`

---

## Technical Constraints and Notes

- **Manifest V3**: Use service workers instead of background pages if any background processing is needed. For v1, the background script can be omitted entirely — all logic lives in popup.js and content.js.
- **No external network calls from the extension itself**: All processing is local. The only outbound action is the mailto trigger.
- **Readability.js must be bundled locally**: Do not reference external CDN URLs in the extension manifest.
- **Content Security Policy**: Chrome extensions have strict CSP. Do not use `eval()` or inline event handlers.
- **Substack paywalled content**: Since the extension runs in the user's authenticated browser session, subscribed paid content is accessible via DOM extraction. The extension does not bypass any authentication — it simply reads what the user can already see.

---

## Suggested Build Order

1. Set up the manifest and basic extension scaffold — get the icon appearing in Chrome
2. Build the popup HTML/CSS with static placeholder content to nail the UI
3. Implement Readability.js extraction in content.js and verify clean output on a test article
4. Wire up popup.js to trigger extraction and display title/author correctly
5. Implement Chrome storage for Kindle email and onboarding flow
6. Implement the mailto send for single articles
7. Implement the queue — add, view count, clear
8. Implement digest compilation and send
9. Polish error states and edge cases
10. Test on a variety of Substack articles (free and paid, long and short, image-heavy and text-only)

---

## Out of Scope for V1

- Firefox or Safari support
- Silent background sending without opening mail client
- Automatic sync with Substack's saved articles list
- Scheduling or recurring digests
- Custom formatting options
- Chrome Web Store submission (build and test locally first via `chrome://extensions` in developer mode)
