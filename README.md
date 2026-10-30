# Read on Kindle

Read on Kindle is a Chrome extension that sends the article you're reading to your Kindle.

Say you're on a Substack post, a blog or a news story. Click the extension, hit Send, and a few minutes later the article is on your Kindle, ready to read like a book. Pictures included.

<img width="412" height="578" alt="file-0cebc3415418480bef9366ad7481e09e" src="https://github.com/user-attachments/assets/944ced26-9601-4449-85e3-522bf856d70f" />



<img width="430" height="280" alt="image" src="https://github.com/user-attachments/assets/3cc90903-f3ec-4da8-b323-2b511ad89981" />


## Why I built it

Some of the best long reads online are newsletters, and a phone is a bad place to read a long essay. Amazon lets you email files to your Kindle, but getting a web page there cleanly takes too many steps for one article. This makes it one click.

## What you can do with it

- Send the article you're on. You get the words and pictures, and the menus, ads and pop-ups stay behind.
- Save a few for later. Add articles to a queue, then send them together as one "Reading Digest" with a table of contents.
- Use it outside Substack. It works on lots of blogs and news sites too.

It also gives you a heads up when something's off, like a paywalled post where only the preview loaded, so you don't end up with half an article.

## Is it safe?

Everything happens in your browser. There's no company server in the middle. The article goes out from your own Gmail account, and the extension only has permission to send email, so it can't read your inbox. Your Kindle address stays on your computer. The [privacy policy](docs/privacy-policy.html) has the details.

## What you need

- A Gmail account
- A Kindle, or the Kindle app on your phone or tablet
- Your Kindle's email address. Amazon gives every Kindle one. Find it on Amazon under Manage Your Content and Devices, then Devices, then your Kindle.
- Your Gmail address on Amazon's approved sender list, under Preferences, then Personal Document Settings. Amazon only delivers email from addresses on that list.

The first time you open the extension, it asks for your Kindle address. The first time you send, Google asks you to sign in and allow it to send email. After that it's one click.

It's not on the Chrome Web Store, so to try it you install it from this repo using the steps below.

## For developers

```sh
git clone https://github.com/jessekinzer/read-on-kindle.git
cd read-on-kindle
npm install
```

Open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the folder.

Google ties Gmail sign-in to the extension's ID, and your unpacked copy gets its own ID. To send from it, create OAuth clients in Google Cloud for that ID and swap the client IDs into `manifest.json` and `gmail.js`. [PUBLISH_CHECKLIST.md](PUBLISH_CHECKLIST.md) has the steps.

How it works under the hood:

1. [Readability](https://github.com/mozilla/readability), Mozilla's library behind Firefox Reader View, pulls the article out of the page.
2. A background worker builds a clean HTML file and embeds the images, converting WebP and AVIF (which Kindles can't show) to JPEG and staying under Gmail's size limit.
3. The Gmail API sends it with the send-only permission. Because the send runs in the background, it finishes even if the popup closes when Google's sign-in window opens.

Tests:

```sh
npm test            # unit tests (Jest)
npm run test:e2e    # loads the real extension in Chromium
npm run test:live   # runs extraction against 48 live web pages
```

The live suite covers free and paid Substacks, Ghost, WordPress, Medium, Webflow, Framer, Next.js sites, major news outlets, documentation sites and hand-built personal pages. Each page has an expected result (send it, flag it as paywalled, or flag it as not an article), and the homepages and search results in the set make sure it says no when it should. Nothing gets emailed during the run.

Built with Readability.js by Mozilla (Apache 2.0, included in `lib/`), Chrome Manifest V3, the Gmail API, Jest and Playwright.

Read on Kindle is a side project and isn't affiliated with Substack or Amazon.
