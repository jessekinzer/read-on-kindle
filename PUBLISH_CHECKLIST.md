# Chrome Web Store – Publishing Checklist

Use this file to copy-paste text into the Chrome Web Store developer console.

---

## Store Listing Text

### Extension Name
```
Substack to Kindle
```

### Short Description (132 characters max)
```
Send any Substack article to your Kindle in one click — including newsletters on custom domains.
```

### Full Description
```
Send Substack articles to your Kindle with a single click.

HOW IT WORKS:
1. Open any Substack article (on substack.com or a custom domain)
2. Click the Substack to Kindle icon in your toolbar
3. Enter your Kindle email address (e.g. yourname@kindle.com) — only needed once
4. Click "Send to Kindle"

The article is formatted as a clean email and sent directly to your Kindle via your Gmail account. It shows up in your Kindle library ready to read.

FEATURES:
• Works on substack.com and newsletters hosted on custom domains
• Strips ads and clutter — just clean article text
• Saves your Kindle email so you don't re-enter it each time
• Uses your existing Gmail account — no new accounts needed
• Sends as a properly formatted email attachment

PERMISSIONS EXPLAINED:
• "Read and change your data on substack.com sites" — needed to read Substack articles and download their images for the Kindle file. On every other site (custom-domain newsletters, blogs, news sites) the extension reads only the tab you are on, and only when you click its icon.
• "Read and change all your data on all websites" (optional, off by default) — asked only if you turn on "Include images from any site" in Settings. It lets the extension download article images that a website stores on another server. It is used only for the images in an article you send, and you can turn it off again in Settings.
• Gmail (send only) — used solely to send the Kindle email. The extension cannot read, modify, or access your existing emails.

PRIVACY:
No data is collected or stored on any server. Your Kindle email address is saved only on your device. See the full privacy policy linked below.

REQUIREMENTS:
• A Gmail or Google Workspace account, signed in to Chrome (articles are sent from that account)
• A Kindle device or the Kindle app
• Your Kindle's email address (find it at amazon.com/mycd → Devices → your Kindle → Send-to-Kindle Email)
• Add your Gmail address to Amazon's approved sender list (amazon.com/mycd → Preferences → Personal Document Settings)
```

### Category
```
Productivity
```

### Language
```
English
```

---

## Screenshots Needed

You need at least **1 screenshot** before you can publish.
Accepted sizes: **1280×800** or **640×400** pixels, PNG or JPG.

Suggested screenshots to take:
1. The popup open on a Substack article (shows the send button and Kindle email field)
2. A Kindle showing the delivered article (optional but great social proof)

How to take a 1280×800 screenshot:
1. Open Chrome and navigate to any Substack article
2. Click the extension icon so the popup is open
3. Press Cmd+Shift+4 then Space, click the browser window (Mac)
   OR use Chrome DevTools → toggle device toolbar → set to 1280×800 and screenshot

---

## Privacy Policy URL

After you push this repo to GitHub and enable GitHub Pages, your URL will be:
```
https://YOUR-GITHUB-USERNAME.github.io/substack_to_kindle/privacy-policy.html
```

Replace YOUR-GITHUB-USERNAME with your actual GitHub username.

### How to enable GitHub Pages:
1. Go to your repo on github.com
2. Click Settings → Pages (left sidebar)
3. Under "Source" → select "Deploy from a branch"
4. Branch: main, Folder: /docs
5. Click Save
6. Wait ~2 minutes, then visit the URL above to confirm it works

---

## Google OAuth Setup (Required before submitting)

1. Go to https://console.cloud.google.com
2. Create a new project named "Substack to Kindle"
3. Search for and enable the "Gmail API"
4. Go to APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID
5. Application type: "Chrome Extension"
6. In "Item ID" field: paste your extension ID (visible in Chrome after you upload the ZIP for the first time)
7. Copy the new client_id
8. Open manifest.json and replace the client_id value with your new one
9. Rebuild the ZIP (see below)

---

## Building the Final ZIP

Run this command in the project folder (Terminal → cd into the folder first):

```bash
cd /Users/jk/Documents/GitHub/substack_to_kindle
zip -r substack-to-kindle.zip manifest.json background.js popup.html popup.css popup.js content.js gmail.js icons/icon16.png icons/icon48.png icons/icon128.png lib/Readability.js
```

Or ask Claude Code: "build the production ZIP"

---

## Submission Steps (In Order)

- [ ] 1. Run the icon generator: open `icons/generate-icons.html` in Chrome, click Download All, replace the files in `icons/`
- [ ] 2. Push the repo to GitHub (if not done already)
- [ ] 3. Enable GitHub Pages (docs folder) and verify the privacy policy URL loads
- [ ] 4. Go to https://chrome.google.com/webstore/devconsole and pay the $5 fee
- [ ] 5. Upload the ZIP — note the Extension ID shown after upload
- [ ] 6. Set up OAuth in Google Cloud Console using that Extension ID
- [ ] 7. Update manifest.json with the new client_id, rebuild ZIP, re-upload
- [ ] 8. Fill in all store listing fields using the text above
- [ ] 9. Upload at least 1 screenshot
- [ ] 10. Enter the privacy policy URL
- [ ] 11. Click "Submit for review"
```
