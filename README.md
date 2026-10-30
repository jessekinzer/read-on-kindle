# Read on Kindle

A Chrome extension that sends the article you're reading to your Kindle. Click the icon, hit Send, and a few minutes later it's in your Kindle library with the images intact.

It started with Substack. Some of the best long-form writing online lives in newsletters, and a phone is a bad place to read a long essay. Amazon's Send to Kindle works fine for files, but getting a web page into it cleanly takes more steps than anyone will do for one article. So I built the one-click version.

## What it does

Send one article and the page gets stripped down to the title, byline, text and images. It lands on your Kindle as its own document, named after the article.

Or hit Add to Queue on anything you want to read later. When you're ready, Send Digest bundles the whole queue into one document called "Reading Digest," with the date and a linked table of contents up front.

It works on Substack (substack.com or a custom domain), and also on Ghost, WordPress, Medium, Webflow, Framer, news sites and personal blogs.

Images come along too. A lot of sites now serve WebP or AVIF, and Kindles can't show either, so the extension downloads each image, converts anything the Kindle can't display to JPEG, and embeds it in the file. It keeps the total under Gmail's attachment limit.

It also warns you before you send half an article. If a post is paywalled and only the preview loaded, it says so. Point it at a homepage or a list of links and it tells you that's not a single article. Either way you can still send what it found.

## How it works

Everything runs in your browser. There's no server.

1. When you click the icon, the extension reads the current tab with [Readability](https://github.com/mozilla/readability), Mozilla's library behind Firefox Reader View, and pulls out the article.
2. A background worker formats it as a clean HTML file and embeds the images.
3. It emails the file to your Kindle address from your own Gmail account, through the Gmail API with send-only access. It can't read your inbox.

The send runs in the background, so you can close the popup mid-send. That matters on your first send: Google's sign-in window opens and closes the popup, and the article still goes out.

Your Kindle address stays on your device and nothing is collected. Full details in the [privacy policy](docs/privacy-policy.html).

## Setup

You'll need:

- A Gmail or Google Workspace account
- A Kindle or the Kindle app, and its Send-to-Kindle email address (on Amazon: Manage Your Content and Devices, then Devices, then your Kindle)
- Your Gmail address on Amazon's approved sender list (Preferences, then Personal Document Settings)

The first time you open the extension it asks for your Kindle address. The first time you send, Google asks you to sign in and allow sending email. After that it's one click.

Sign-in works in Google Chrome through your Chrome account, and in other Chromium browsers like Brave, Edge and Arc through a Google sign-in window.

Substack images work out of the box. Some sites keep their images on a different server; for those, turn on "Include images from any site" in Settings and Chrome asks once for permission.

### Running it from source

```sh
git clone https://github.com/jessekinzer/read-on-kindle.git
cd read-on-kindle
npm install
```

Open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the folder.

One catch: Google ties sign-in to the extension's ID, and an unpacked copy gets a new one. To send from your own copy, create OAuth clients in Google Cloud for that ID and swap the client IDs into `manifest.json` and `gmail.js`. [PUBLISH_CHECKLIST.md](PUBLISH_CHECKLIST.md) walks through it.

## Testing

```sh
npm test            # unit tests (Jest)
npm run test:e2e    # loads the real extension in Chromium
npm run test:live   # runs extraction against 48 live web pages
```

The live suite is my favorite part. It's 48 real pages: free and paid Substacks, Ghost, WordPress, Medium, Webflow, Framer, HubSpot, Next.js sites from Stripe, Vercel and Linear, the BBC, NPR, The Guardian, The Atlantic, docs from MDN, Python and React, and a handful of hand-built personal sites. Each page has an expected result: send it, flag it as paywalled, or flag it as not an article. Homepages, search results and a link aggregator are in there to make sure the extension refuses them. Nothing gets emailed during the run.

## Built with

- [Readability.js](https://github.com/mozilla/readability) by Mozilla (Apache 2.0), included in `lib/`
- Chrome Manifest V3
- Gmail API
- Jest and Playwright

Read on Kindle is an independent project and isn't affiliated with Substack or Amazon.
