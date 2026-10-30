'use strict';

// End-to-end test of the unpacked extension in Chrome for Testing.
//
//   npm run test:e2e
//
// Pages come from local fixtures (Playwright request routing), and Gmail and
// Google sign-in are mocked inside the service worker, so no real email is
// ever sent and no Google account is needed.
//
// Browser: uses S2K_CHROME if set, else Playwright's own Chromium, else the
// newest Chrome for Testing already in Playwright's browser cache. If none is
// found, run `npx playwright install chromium` once.
//
// Permissions that automation cannot grant are stood in for by a test copy of
// the extension whose manifest lists a few fixture origins:
//   - CUSTOM_DOMAIN and SITE: in real use Chrome grants the page's site through
//     activeTab when the toolbar icon is clicked, which automation can't do.
//   - CDN_GRANTED: stands in for the optional "<all_urls>" permission the user
//     turns on in Settings. CDN_OTHER is not listed, so it behaves like an
//     image host the user has not allowed.
// Everything else is the shipped code. The Settings toggle itself is tested
// with chrome.permissions stubbed, because the permission prompt can't be
// answered from automation.

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SHIPPED_FILES, findChrome, stageShippedExtension } = require('./chrome');
const CUSTOM_DOMAIN = 'https://www.janes-letter.example';
const SITE = 'https://site.example';
const CDN_GRANTED = 'https://cdn-granted.example';
const CDN_OTHER = 'https://cdn-other.example';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WEBP = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');

// ─── Browser and extension setup ─────────────────────────────────────────────

/** Copy the shipped files to a temp folder, adding the fixture custom domain (see top). */
function stageExtension() {
  const dir = stageShippedExtension(SHIPPED_FILES, [`${CUSTOM_DOMAIN}/*`, `${SITE}/*`, `${CDN_GRANTED}/*`]);
  // A stand-in web OAuth client, so the web sign-in path runs (its Google
  // side is mocked in the service worker).
  const gmailPath = path.join(dir, 'gmail.js');
  fs.writeFileSync(gmailPath, fs.readFileSync(gmailPath, 'utf8')
    .replace(/(const WEB_OAUTH_CLIENT_ID = )'[^']*'/, "$1'e2e-web-client.apps.googleusercontent.com'"));
  return dir;
}

/** Chrome's ID for an unpacked extension: SHA-256 of its folder path, first 32 hex digits mapped 0-f to a-p. */
function unpackedExtensionId(dir) {
  return require('crypto').createHash('sha256').update(dir).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function articlePage({ host = 'https://jane.substack.com', slug, title, body, extraHead = '<meta name="generator" content="Substack">', afterBody = '' }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${title} - Jane's Newsletter</title>
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta name="author" content="Jane Writer">
<link rel="canonical" href="${host}/p/${slug}">
${extraHead}
</head><body>
<nav>Home Archive About Subscribe</nav>
<article class="post">
<h1 class="post-title">${title}</h1>
<time datetime="2026-03-01T10:00:00Z">Mar 1</time>
<div class="available-content"><div class="body markup">
${body}
</div></div>
${afterBody}
</article>
<footer>Recommended posts, comments, share buttons</footer>
</body></html>`;
}

const LONG = Array.from({ length: 8 }, (_, i) =>
  `<p>Paragraph ${i + 1}. The quick brown fox jumps over the lazy dog, and the essay keeps going with real sentences so Readability treats this as the main content of the page.</p>`).join('\n')
  + '<picture><source type="image/webp" srcset="https://substackcdn.com/image/a.webp 1x">'
  + '<img src="https://substackcdn.com/image/a.png?w=1&amp;f=auto" srcset="https://substackcdn.com/image/a.png 2x" alt="chart"></picture>';

// Substack's markup for the free preview of a paid post (checked against a live page, 2026-10).
const PAYWALL = '<div data-testid="paywall" data-component-name="Paywall" role="region" aria-label="Paywall" class="paywall">'
  + '<h2 class="paywall-title">This post is for paid subscribers</h2></div>';

const SUBSTACK_PAGES = {
  '/p/first': articlePage({ slug: 'first', title: 'First Essay — on Dashes', body: LONG }),
  '/p/second': articlePage({ slug: 'second', title: 'Second Essay', body: LONG }),
  '/p/locked': articlePage({ slug: 'locked', title: 'Locked Post', body: '<p>Subscribe to read.</p>' }),
  '/p/preview': articlePage({ slug: 'preview', title: 'Paid Post', body: LONG, afterBody: PAYWALL }),
  // A short paid post as a paying subscriber sees it: Substack's JSON-LD marks
  // every paid post isAccessibleForFree:false (checked on a live paid post,
  // 2026-10), but there is no paywall block and the whole text is there.
  '/p/paid-short': articlePage({
    slug: 'paid-short',
    title: 'Short Paid Note',
    body: LONG.split('\n').slice(0, 5).join('\n'),
    extraHead: '<meta name="generator" content="Substack">'
      + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Short Paid Note","isAccessibleForFree":false}</script>',
  }),
};
// A custom-domain newsletter: no substack.com in the URL and no generator tag
// (live custom-domain pages had none in 2026-10), only Substack CDN assets.
const CUSTOM_PAGE = articlePage({
  host: CUSTOM_DOMAIN,
  slug: 'custom',
  title: 'Custom Domain Essay',
  body: LONG,
  extraHead: '<link rel="stylesheet" href="https://substackcdn.com/bundle/theme/main.css">',
});

// ─── Fixtures: any website ───────────────────────────────────────────────────

const PARAS = (n, topic) => Array.from({ length: n }, (_, i) =>
  `<p>${topic} paragraph ${i + 1}. This is ordinary article prose with complete sentences, long enough that a reader view treats it as the main text of the page rather than navigation.</p>`).join('\n');

function sitePage({ title, head = '', body, chrome = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} | Example Site</title>
<meta property="og:title" content="${title}">${head}</head><body>
<header><nav><a href="/">Home</a> <a href="/news/latest">Latest</a> <a href="/about">About</a></nav></header>
<main>${body}</main>${chrome}
<footer><a href="/privacy">Privacy</a> <a href="/terms">Terms</a></footer></body></html>`;
}

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

const SITE_PAGES = {
  // A free blog post with no Substack markers: same-site PNG and WebP images,
  // one image on an allowed CDN, one on a CDN the user has not allowed.
  '/blog/free-post': sitePage({
    title: 'A Free Blog Post',
    head: '<meta property="og:type" content="article"><meta name="author" content="Sam Blogger">',
    body: `<article><h1>A Free Blog Post</h1>${PARAS(6, 'Blog')}
<figure><img src="/img/photo.png" alt="same-site png"></figure>
<figure><img src="/img/pic.webp" alt="same-site webp"></figure>
<figure><img src="${CDN_GRANTED}/img/allowed.png" alt="allowed cdn"></figure>
<figure><img src="${CDN_OTHER}/img/blocked.png" alt="other cdn"></figure>
${PARAS(2, 'Closing')}</article>`,
  }),
  // A free article that talks about paywalls in its body, plus a newsletter box.
  '/blog/subscribe-word': sitePage({
    title: 'Why I Hate Paywalls',
    head: '<meta property="og:type" content="article">',
    body: `<article><h1>Why I Hate Paywalls</h1>${PARAS(4, 'Opinion')}
<p>Every time a site says "subscribe to continue reading" I close the tab, and when it says you have reached your free article limit I leave for good. This post is free and always will be.</p>
${PARAS(3, 'More')}</article>
<aside class="newsletter-signup"><h3>Subscribe to our newsletter</h3><p>Get new posts by email.</p></aside>`,
  }),
  // Google's paywalled-content markup, with the paid part missing (non-subscriber view).
  '/news/paid-ld': sitePage({
    title: 'Markets Rally on Rate News',
    head: ld({ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'Markets Rally on Rate News', isAccessibleForFree: false,
      hasPart: { '@type': 'WebPageElement', isAccessibleForFree: false, cssSelector: '.paid-content' } }),
    body: `<article><h1>Markets Rally on Rate News</h1>${PARAS(3, 'Teaser')}</article>`,
  }),
  // The same markup seen by a subscriber: the paid part is on the page.
  '/news/subscriber-view': sitePage({
    title: 'Subscriber Sees Everything',
    head: ld({ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'Subscriber Sees Everything', isAccessibleForFree: false,
      hasPart: { '@type': 'WebPageElement', isAccessibleForFree: false, cssSelector: '.paid-content' } }),
    body: `<article><h1>Subscriber Sees Everything</h1>${PARAS(2, 'Free')}<div class="paid-content">${PARAS(10, 'Paid')}</div></article>`,
  }),
  // Piano/TinyPass-style regwall over a metered article.
  '/news/piano': sitePage({
    title: 'Metered Story',
    head: '<meta property="og:type" content="article">',
    body: `<article><h1>Metered Story</h1>${PARAS(8, 'Metered')}</article>`,
    chrome: '<div class="tp-backdrop tp-active"></div><div class="tp-modal"><div class="tp-container-inner">'
      + '<h2>You have reached your free article limit</h2><p>Create a free account to continue reading.</p><button>Sign up</button></div></div>',
  }),
  // Medium-style member-only story, non-member view.
  '/medium/member-story': sitePage({
    title: 'Member Only Story',
    head: '<meta property="og:type" content="article">'
      + ld({ '@context': 'http://schema.org', '@type': 'SocialMediaPosting', headline: 'Member Only Story', isAccessibleForFree: 'False' }),
    body: `<article><h1>Member Only Story</h1><span>Member-only story</span>${PARAS(3, 'Preview')}
<div><h2>The author made this story available to Medium members only.</h2><p>If you're new to Medium, create a new account to read this story on us.</p></div></article>`,
  }),
  // Ghost members-only post (markup from a live 404 Media page, 2026-10): the
  // paywall box sits inside the article, so the reader view takes it in.
  '/ghost/locked': sitePage({
    title: 'Behind the Blog',
    head: '<meta property="og:type" content="article">',
    body: `<article class="post post-access-paid"><h1>Behind the Blog</h1><div class="post__content">${PARAS(2, 'Teaser')}
<div class="post-access-cta"><div class="paid"><h2>This post is for paid members only</h2>
<div class="description">Become a paid member for unlimited ad-free access to articles, bonus podcast content, and more.</div>
<a class="btn" href="/membership/">Subscribe</a></div><div class="sign-in">Already have an account? <a href="/signin/">Sign in</a></div></div></div></article>`,
  }),
  // A free post whose reader comments mention paywalls elsewhere.
  '/blog/with-comments': sitePage({
    title: 'Free Post With Comments',
    head: '<meta property="og:type" content="article">',
    body: `<article><h1>Free Post With Comments</h1>${PARAS(6, 'Commented')}</article>
<section id="comments"><h2>3 Comments</h2><ol class="comment-list">
<li class="comment"><p>Thanks! The other site made me subscribe to keep reading, glad this one is free.</p></li>
<li class="comment"><p>This article is for subscribers only on their app, weird.</p></li></ol>
<div class="comment-respond"><p>Log in to leave a comment.</p></div></section>`,
  }),
  // A metered news site (Google's paywalled-content markup) read by someone
  // with free articles left: the paid part is all there, plus a meter banner.
  '/news/metered': sitePage({
    title: 'Metered But Readable',
    head: ld({ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'Metered But Readable', isAccessibleForFree: false,
      hasPart: { '@type': 'WebPageElement', isAccessibleForFree: false, cssSelector: '.paid-content' } }),
    body: `<article><h1>Metered But Readable</h1>${PARAS(2, 'Lead')}<div class="paid-content">${PARAS(10, 'Metered body')}</div></article>`,
    chrome: '<div class="paywall-meter-banner">You have 2 free articles left this month. Subscribe for unlimited access.</div>',
  }),
  // Japanese article: schema.org wordCount counts characters, and the text has no spaces.
  '/news/japanese': sitePage({
    title: 'Japanese Article',
    head: '<meta property="og:type" content="article">'
      + ld({ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'Japanese Article', wordCount: 2400 }),
    body: `<article><h1>日本語の記事</h1>${Array.from({ length: 12 }, (_, i) =>
      `<p>${'これは日本語で書かれた普通の記事の段落です。読みやすい文章が続きます。'.repeat(6)}${i}</p>`).join('\n')}</article>`,
  }),
  // Modelled on clay.com/blog (Webflow, checked live 2026-10-11): og:type
  // "website", only a WebSite JSON-LD, a mega menu whose hidden link text
  // outweighs the visible page, the author in a tooltip, and the site name in
  // the last segment of og:title.
  '/blog/webflow-style': `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>The Three Laws of Example: How to Win in 2026 - The Growth with Example Blog</title>
<meta property="og:type" content="website"><meta property="og:site_name" content="Example">
<meta property="og:title" content="The Three Laws of Example: How to Win in 2026 - The Growth with Example Blog">
${ld({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Example', url: `${SITE}/` })}</head><body>
<nav class="navbar"><a href="/">Example</a><div class="dropdown-list" style="display:none">${Array.from({ length: 120 }, (_, i) =>
    `<a href="/p/${i}">Product page number ${i} with a long descriptive menu label for the mega menu</a>`).join('')}</div></nav>
<main><div class="blog-hero"><h1>The Three Laws of Example: How to Win in the AI Era</h1>
<div class="author-tooltip"><span>Kareem Example</span></div></div>
<div class="w-richtext">${PARAS(12, 'Webflow')}</div></main>
<footer><a href="/privacy">Privacy</a></footer></body></html>`,
  // A news homepage and a section page full of headline links.
  '/': sitePage({
    title: 'Example News',
    head: '<meta property="og:type" content="website">',
    body: Array.from({ length: 20 }, (_, i) => `<div class="card"><a href="/news/story-${i}"><h3>Headline number ${i} about events today</h3></a><p>Short teaser ${i}.</p></div>`).join(''),
  }),
  '/news/latest': sitePage({
    title: 'Latest News',
    head: '<meta property="og:type" content="website">',
    body: Array.from({ length: 30 }, (_, i) => `<section><h3><a href="/news/story-${i}">A much longer headline number ${i} that describes a story at some length for readers</a></h3>`
      + `<p><a href="/news/story-${i}">Read the full story ${i} with all of its details, quotes, pictures and background reporting here</a></p></section>`).join(''),
  }),
};

// substack.com's reader app (what a signed-in reader sees at
// substack.com/home/post/p-…): every page carries <meta name="author"
// content="Substack"> and og:site_name "Substack" (checked live 2026-10-11).
// The writer is only in the byline. A second post has no byline at all.
const SUBSTACK_APP = (withByline) => `<!doctype html><html><head><meta charset="utf-8">
<title>How To Be With Little Children At Home - by Emily Example</title>
<meta name="author" content="Substack" /><meta property="og:site_name" content="Substack"/>
<meta property="og:type" content="article"/><meta property="og:title" content="How To Be With Little Children At Home"/>
</head><body><div class="reader-nav"><a href="/home">Home</a> <a href="/inbox">Inbox</a></div>
<article class="newsletter-post post"><div class="post-header"><h1 class="post-title">How To Be With Little Children At Home</h1>
${withByline ? '<div class="byline-wrapper"><a href="https://substack.com/@emilyexample" aria-label="View Emily Example\'s profile"><div title="Emily Example"></div></a>'
    + '<div><a href="https://substack.com/@emilyexample">Emily Example</a></div></div>' : ''}
</div><div class="available-content"><div class="body markup">${LONG}</div></div></article></body></html>`;

// A WordPress post on "Plain" permalinks lives at the site root: /?p=42.
const WP_PLAIN_PERMALINK = sitePage({
  title: 'Plain Permalink Post',
  head: `<meta property="og:type" content="article"><link rel="canonical" href="${SITE}/?p=42">`,
  body: `<article><h1>Plain Permalink Post</h1>${PARAS(6, 'WordPress')}</article>`,
});

// ─── Test harness ────────────────────────────────────────────────────────────

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** Split a raw RFC 822 message into headers (unfolded) and the decoded HTML attachment. */
function parseMail(raw) {
  const [head] = raw.split('\r\n\r\n');
  const headers = {};
  head.replace(/\r\n /g, ' ').split('\r\n').forEach((line) => {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  });
  const subject = headers.subject.replace(/=\?UTF-8\?B\?([^?]+)\?=\s?/g, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));
  const part = raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n\r\n--')[0];
  const filename = (raw.match(/Content-Disposition: attachment; filename="([^"]*)"/) || [])[1];
  return {
    headers,
    subject,
    filename,
    asciiOnly: /^[\x00-\x7F]*$/.test(raw),
    linesOk: raw.split('\r\n').every((l) => l.length <= 998),
    html: Buffer.from(part.replace(/\r\n/g, ''), 'base64').toString('utf8'),
  };
}

async function main() {
  const extDir = stageExtension();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 's2k-profile-'));
  const executablePath = findChrome();
  console.log(`Chrome: ${executablePath}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: process.env.S2K_HEADED ? false : true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });

  try {
    await run(context, extDir);
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

async function run(context, extDir) {
  await context.route('https://jane.substack.com/**', (route) => {
    const page = SUBSTACK_PAGES[new URL(route.request().url()).pathname];
    return page
      ? route.fulfill({ status: 200, contentType: 'text/html', body: page })
      : route.fulfill({ status: 404, body: 'not found' });
  });
  await context.route('https://substack.com/**', (route) => {
    const { pathname } = new URL(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: SUBSTACK_APP(pathname.endsWith('p-1')) });
  });
  await context.route(`${CUSTOM_DOMAIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: CUSTOM_PAGE }));
  await context.route('https://example.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><head><title>Not Substack</title></head><body><p>Hello</p></body></html>' }));
  await context.route(`${SITE}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/img/')) {
      // Same-site images are only served to requests made from the page (they
      // carry the page as referer; the service worker's don't), which proves
      // they were fetched by the page-side code under activeTab.
      const headers = await route.request().allHeaders();
      if (!(headers.referer || '').startsWith(`${SITE}/`)) return route.fulfill({ status: 403, body: 'forbidden' });
      return pathname.endsWith('.webp')
        ? route.fulfill({ status: 200, contentType: 'image/webp', body: WEBP })
        : route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    const page = pathname === '/' && new URL(route.request().url()).searchParams.get('p') === '42'
      ? WP_PLAIN_PERMALINK : SITE_PAGES[pathname];
    return page
      ? route.fulfill({ status: 200, contentType: 'text/html', body: page })
      : route.fulfill({ status: 404, body: 'not found' });
  });
  await context.route(`${CDN_GRANTED}/**`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  // In real use, Chrome's CORS check stops the extension reading an image from a
  // host it has no permission for. Playwright-fulfilled responses skip that
  // check, so this host refuses extension-origin (CORS) requests itself, which
  // has the same effect. The page's own image loads still work.
  await context.route(`${CDN_OTHER}/**`, async (route) => {
    const { origin = '' } = await route.request().allHeaders();
    return origin.startsWith('chrome-extension://')
      ? route.fulfill({ status: 403, body: 'cors' })
      : route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  await context.route('https://substackcdn.com/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('.css')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = sw.url().split('/')[2];
  check('extension loads and service worker starts', !!extId, extId);
  const redirect = await sw.evaluate(() => chrome.identity.getRedirectURL());
  check('unpacked extension ID follows SHA-256(folder path), and the redirect URL is https://<id>.chromiumapp.org/',
    [extDir, fs.realpathSync(extDir)].some((d) => unpackedExtensionId(d) === extId) && redirect === `https://${extId}.chromiumapp.org/`,
    `${redirect}; path hash ${unpackedExtensionId(extDir)}, realpath hash ${unpackedExtensionId(fs.realpathSync(extDir))}`);
  console.log(`      browser brands in the service worker: ${JSON.stringify(await sw.evaluate(() => navigator.userAgentData && navigator.userAgentData.brands))}`);

  const swErrors = [];
  if (typeof sw.on === 'function') sw.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });

  // Gmail and Google sign-in, mocked inside the service worker.
  async function mockGmail(mode) {
    await sw.evaluate(({ mode: m, png }) => {
      self.__sent = self.__sent || [];
      self.__mode = m;
      if (!self.__origFetch) self.__origFetch = self.fetch;
      self.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.includes('googleapis.com')) {
          if (self.__mode === 'network') throw new TypeError('Failed to fetch');
          if (self.__mode === 'slow') await new Promise((r) => setTimeout(r, 1500));
          self.__sent.push({ url: u, headers: init.headers, body: init.body });
          if (self.__mode === 'server') {
            return new Response(JSON.stringify({ error: { message: 'Backend Error' } }), { status: 500, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify({ id: 'mock' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (u.includes('substackcdn.com')) {
          const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
          return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return self.__origFetch(url, init);
      };
      // Google's web sign-in page (launchWebAuthFlow), answering like Google:
      // the state and nonce echoed back, a token in the URL fragment.
      self.__flows = self.__flows || [];
      chrome.identity.launchWebAuthFlow = (details, cb) => {
        const p = new URL(details.url).searchParams;
        self.__flows.push({ interactive: details.interactive, prompt: p.get('prompt'), hint: p.get('login_hint'), clientId: p.get('client_id') });
        if (self.__mode === 'web_cancel' && details.interactive) {
          chrome.runtime.lastError = { message: 'The user did not approve access.' };
          cb(undefined);
          delete chrome.runtime.lastError;
          return;
        }
        const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const idToken = `${b64({ alg: 'none' })}.${b64({ nonce: p.get('nonce'), email: 'reader@gmail.com' })}.sig`;
        cb(`${chrome.identity.getRedirectURL()}#access_token=web-token-${self.__flows.length}&token_type=Bearer`
          + `&expires_in=${self.__expiresIn || 3600}&state=${p.get('state')}&scope=${encodeURIComponent(p.get('scope'))}&id_token=${idToken}`);
      };
      self.__chromeAuthCalls = self.__chromeAuthCalls || 0;
      chrome.identity.getAuthToken = (opts, cb) => {
        self.__chromeAuthCalls += 1;
        if (self.__mode === 'signin_off' || self.__mode === 'web_cancel') {
          chrome.runtime.lastError = { message: 'The user turned off browser signin' };
          cb(undefined);
          delete chrome.runtime.lastError;
          return;
        }
        cb('fake-token');
      };
    }, { mode, png: PNG.toString('base64') });
  }
  await mockGmail('ok');
  const sentCount = () => sw.evaluate(() => self.__sent.length);
  const lastSent = () => sw.evaluate(() => self.__sent[self.__sent.length - 1]);

  async function openTab(url) {
    const page = await context.newPage();
    await page.goto(url);
    return page;
  }
  async function tabIdFor(url) {
    return sw.evaluate(async (u) => {
      const [match] = await chrome.tabs.query({ url: u });
      if (match) return match.id;
      // No host permission for this URL, so tabs.query can't filter by it: use the newest tab.
      const all = await chrome.tabs.query({});
      return Math.max(...all.map((t) => t.id));
    }, url);
  }

  const popupErrors = [];
  async function openPopupFor(url, extraInit) {
    const tabId = url ? await tabIdFor(url) : null;
    const popup = await context.newPage();
    popup.on('console', (m) => { if (m.type() === 'error') popupErrors.push(m.text()); });
    popup.on('pageerror', (e) => popupErrors.push(String(e)));
    await popup.addInitScript((id) => {
      // The popup is opened as a tab here, so it would see itself as the active tab.
      chrome.tabs.query = async () => (id == null ? [] : [await chrome.tabs.get(id)]);
    }, tabId);
    if (extraInit) await popup.addInitScript(extraInit.fn, extraInit.arg);
    const t0 = Date.now();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    return { popup, t0 };
  }
  const visible = (p, sel) => p.locator(sel).isVisible();
  const text = (p, sel) => p.locator(sel).innerText();
  const waitTitle = (p, s) => p.waitForFunction((x) => document.querySelector('#article-title').textContent.includes(x), s);

  // ── Onboarding ──
  await openTab('https://jane.substack.com/p/first?utm_source=x');
  let { popup } = await openPopupFor('https://jane.substack.com/p/first?utm_source=x');
  check('first open shows onboarding', await visible(popup, '#state-onboarding'));
  await popup.fill('#input-kindle-email-onboarding', 'me@gmail.com');
  await popup.press('#input-kindle-email-onboarding', 'Enter');
  check('non-Kindle address rejected with a message', (await text(popup, '#error-onboarding')).includes('@kindle.com'));
  await popup.fill('#input-kindle-email-onboarding', 'me@kindle.com');
  await popup.click('#btn-save-email');
  await popup.waitForSelector('#state-main:not(.hidden)');
  await waitTitle(popup, 'First Essay');
  check('onboarding saves and moves to main with article info', true);
  await popup.close();

  // ── Article detection ──
  let t0;
  ({ popup, t0 } = await openPopupFor('https://jane.substack.com/p/first?utm_source=x'));
  await waitTitle(popup, 'First Essay');
  check('title and author shown', (await text(popup, '#article-author')) === 'Jane Writer', `${Date.now() - t0} ms to title`);
  check('queue count wording', (await text(popup, '#queue-count')) === '0 articles in queue');

  // ── Send, with a triple click ──
  await popup.evaluate(() => { const b = document.getElementById('btn-send'); b.click(); b.click(); b.click(); });
  await popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 });
  check('send shows confirmation', (await text(popup, '#sent-msg')).includes('Sent to your Kindle'));
  check('triple click sends exactly one email', (await sentCount()) === 1, `sends=${await sentCount()}`);
  let mail = await lastSent();
  check('email goes to the Gmail upload endpoint as RFC 822',
    mail.url.includes('/upload/gmail/v1/users/me/messages/send?uploadType=media') && mail.headers['Content-Type'] === 'message/rfc822');
  let parsed = parseMail(mail.body);
  check('addressed to the saved Kindle email', parsed.headers.to === 'me@kindle.com');
  check('subject round-trips through RFC 2047', parsed.subject === 'First Essay — on Dashes', parsed.subject);
  check('message is 7-bit ASCII with lines under 998 chars', parsed.asciiOnly && parsed.linesOk);
  check('attachment is .html with a readable ASCII name', parsed.filename === 'First Essay - on Dashes.html', parsed.filename);
  check('attachment has the article body and images inlined as data URIs',
    parsed.html.includes('Paragraph 8') && parsed.html.includes('src="data:image/png;base64,'));
  check('attachment drops nav, footer, srcset and <source>',
    !parsed.html.includes('Recommended posts') && !parsed.html.includes('srcset') && !parsed.html.includes('<source'));
  check('attachment links the canonical URL (no utm)',
    parsed.html.includes('https://jane.substack.com/p/first') && !parsed.html.includes('utm_source'));
  await popup.click('#btn-sent-done');
  check('Done returns to main', await visible(popup, '#state-main'));

  // ── Queue ──
  await popup.click('#btn-add-queue');
  await popup.waitForFunction(() => document.querySelector('#queue-count').textContent === '1 article in queue');
  check('add to queue updates count', true);
  await popup.click('#btn-add-queue');
  await popup.waitForFunction(() => document.querySelector('#action-msg').textContent === 'Already in queue');
  check('duplicate add says Already in queue', (await text(popup, '#queue-count')) === '1 article in queue');
  await popup.close();

  await openTab('https://jane.substack.com/p/second');
  ({ popup } = await openPopupFor('https://jane.substack.com/p/second'));
  await popup.waitForFunction(() => !document.querySelector('#btn-add-queue').disabled);
  await popup.click('#btn-add-queue');
  await popup.waitForFunction(() => document.querySelector('#queue-count').textContent === '2 articles in queue');
  check('second article queued', true);

  // ── Digest failure keeps the queue ──
  await mockGmail('server');
  await popup.click('#btn-send-digest');
  await popup.waitForSelector('#state-error:not(.hidden)', { timeout: 10000 });
  check('Gmail 5xx shows a clear error', (await text(popup, '#error-message')).includes('temporary problem'));
  const qAfterFail = await sw.evaluate(async () => (await chrome.storage.local.get('queue')).queue.length);
  check('failed digest keeps the queue', qAfterFail === 2, `queue=${qAfterFail}`);
  check('failure sets a ! badge on the toolbar icon', (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '!');

  // ── Retry digest, succeeds ──
  await mockGmail('ok');
  await popup.click('#btn-retry');
  await popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 });
  check('digest retry succeeds', (await text(popup, '#sent-msg')).includes('Digest sent, 2 articles'));
  parsed = parseMail((await lastSent()).body);
  check('digest has a TOC and both articles',
    parsed.html.includes('href="#article-2"') && parsed.html.includes('First Essay') && parsed.html.includes('Second Essay'));
  check('digest subject and filename', /^Reading Digest, /.test(parsed.subject) && /^Reading Digest, .+\.html$/.test(parsed.filename), parsed.filename);
  await popup.click('#btn-sent-done');
  check('queue cleared after digest', (await text(popup, '#queue-count')) === '0 articles in queue');
  await popup.close();

  // ── Custom-domain Substack ──
  await openTab(`${CUSTOM_DOMAIN}/p/custom`);
  ({ popup } = await openPopupFor(`${CUSTOM_DOMAIN}/p/custom`));
  await waitTitle(popup, 'Custom Domain Essay');
  check('custom-domain newsletter detected as an article', !(await popup.locator('#btn-send').isDisabled()));
  await popup.click('#btn-send');
  await popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 });
  parsed = parseMail((await lastSent()).body);
  check('custom-domain article sent with body and canonical link',
    parsed.html.includes('Paragraph 8') && parsed.html.includes(`${CUSTOM_DOMAIN}/p/custom`));
  await popup.close();

  // ── Any website: a free blog post with images on the same site and on CDNs ──
  await openTab(`${SITE}/blog/free-post`);
  ({ popup } = await openPopupFor(`${SITE}/blog/free-post`));
  await waitTitle(popup, 'A Free Blog Post');
  check('non-Substack blog post: title and author shown',
    (await text(popup, '#article-author')) === 'Sam Blogger' && !(await popup.locator('#btn-send').isDisabled()));
  await popup.click('#btn-send');
  await popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 });
  parsed = parseMail((await lastSent()).body);
  const imgSrcs = [...parsed.html.matchAll(/<img[^>]*\salt="([^"]+)"[^>]*>/g)].map((m) => [m[1], (m[0].match(/src="([^"]{0,40})/) || [])[1]]);
  const srcOf = (alt) => (imgSrcs.find(([a]) => a === alt) || [])[1] || '';
  check('blog post body sent', parsed.html.includes('Blog paragraph 6') && parsed.html.includes('Closing paragraph 2'));
  check('same-site PNG inlined by the page-side code (activeTab)', srcOf('same-site png').startsWith('data:image/png;base64,'), srcOf('same-site png'));
  check('same-site WebP converted to JPEG', srcOf('same-site webp').startsWith('data:image/jpeg;base64,'), srcOf('same-site webp'));
  check('image on an allowed host inlined (permission granted path)', srcOf('allowed cdn').startsWith('data:image/png;base64,'), srcOf('allowed cdn'));
  check('image on a host not allowed keeps its link and the send still succeeds (declined path)',
    srcOf('other cdn').startsWith(`${CDN_OTHER}/`), srcOf('other cdn'));
  check('sent screen explains the missing image and names the setting',
    (await text(popup, '#sent-note')).includes('1 image couldn') && (await text(popup, '#sent-note')).includes('Include images from any site'));
  await popup.close();

  await openTab(`${SITE}/blog/subscribe-word`);
  ({ popup } = await openPopupFor(`${SITE}/blog/subscribe-word`));
  await waitTitle(popup, 'Why I Hate Paywalls');
  await popup.click('#btn-send');
  await popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 });
  check('free article that talks about subscribing is sent (no false paywall)',
    parseMail((await lastSent()).body).html.includes('subscribe to continue reading'));
  await popup.close();

  await openTab(`${SITE}/news/subscriber-view`);
  ({ popup } = await openPopupFor(`${SITE}/news/subscriber-view`));
  await waitTitle(popup, 'Subscriber Sees Everything');
  await popup.click('#btn-send');
  await popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 });
  check('marked-paid article with the paid part on the page (subscriber) is sent',
    parseMail((await lastSent()).body).html.includes('Paid paragraph 10'));
  await popup.close();

  // ── Free articles that look a little like gated ones are still sent ──
  for (const [url, title, mustInclude, label] of [
    [`${SITE}/blog/with-comments`, 'Free Post With Comments', 'Commented paragraph 6', 'free post whose reader comments mention paywalls'],
    [`${SITE}/news/metered`, 'Metered But Readable', 'Metered body paragraph 10', 'metered article with the paid part on the page and a meter banner'],
    [`${SITE}/news/japanese`, 'Japanese Article', '日本語の記事', 'Japanese article with a character-based wordCount'],
    ['https://jane.substack.com/p/paid-short', 'Short Paid Note', 'Paragraph 5', 'short paid Substack post seen by a paying subscriber'],
  ]) {
    await openTab(url);
    ({ popup } = await openPopupFor(url));
    await waitTitle(popup, title);
    await popup.waitForFunction(() => !document.querySelector('#btn-send').disabled);
    const n = await sentCount();
    await popup.click('#btn-send');
    const outcome = await Promise.race([
      popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 }).then(() => 'sent'),
      popup.waitForSelector('#state-error:not(.hidden)', { timeout: 10000 }).then(() => 'error'),
    ]);
    const ok = outcome === 'sent' && (await sentCount()) === n + 1
      && parseMail((await lastSent()).body).html.includes(mustInclude);
    check(`${label}: sent`, ok, outcome === 'error' ? await text(popup, '#error-message') : '');
    await popup.close();
  }

  // ── Clay-style Webflow post: no article markup, hidden mega-menu links ──
  await openTab(`${SITE}/blog/webflow-style`);
  ({ popup } = await openPopupFor(`${SITE}/blog/webflow-style`));
  await waitTitle(popup, 'The Three Laws of Example');
  await popup.waitForFunction(() => document.querySelector('#article-author').textContent === 'Kareem Example', null, { timeout: 10000 })
    .catch(() => {});
  check('Webflow-style post: title without the blog name, author from the page byline',
    (await text(popup, '#article-title')) === 'The Three Laws of Example: How to Win in 2026'
    && (await text(popup, '#article-author')) === 'Kareem Example',
    `${await text(popup, '#article-title')} / ${await text(popup, '#article-author')}`);
  await popup.click('#btn-send');
  await popup.waitForSelector('#state-sent:not(.hidden), #state-error:not(.hidden)', { timeout: 10000 });
  parsed = await visible(popup, '#state-sent') ? parseMail((await lastSent()).body) : null;
  check('Webflow-style post: sent with its body',
    !!parsed && parsed.html.includes('Webflow paragraph 12') && parsed.html.includes('Kareem Example'),
    parsed ? '' : await text(popup, '#error-message'));
  await popup.close();

  // ── substack.com reader app: the platform is never shown as the author ──
  for (const [postPath, expected, label] of [
    ['/home/post/p-1', 'Emily Example', 'writer from the byline, not "Substack"'],
    ['/home/post/p-2', '', 'no byline: no author rather than "Substack"'],
  ]) {
    await openTab(`https://substack.com${postPath}`);
    ({ popup } = await openPopupFor(`https://substack.com${postPath}`));
    await waitTitle(popup, 'How To Be With Little Children At Home');
    await popup.waitForTimeout(500); // the extraction result may refine the author
    const shown = await text(popup, '#article-author');
    await popup.click('#btn-send');
    await popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 });
    const mailHtml = parseMail((await lastSent()).body).html;
    const metaLine = (mailHtml.match(/<p style="font-size: 14px; color: #666;[^>]*>([^<]*)/) || [])[1] || '';
    check(`substack.com reader app: ${label}`,
      shown === expected && !/substack/i.test(shown) && !/\bSubstack\b/.test(metaLine) && (!expected || metaLine.includes(expected)),
      `popup "${shown}", email "${metaLine}"`);
    await popup.close();
  }

  // ── Gated pages are refused, nothing is sent ──
  for (const [pathName, label] of [
    ['/news/paid-ld', 'JSON-LD isAccessibleForFree:false with the paid part missing'],
    ['/news/piano', 'Piano-style regwall overlay'],
    ['/medium/member-story', 'Medium-style member-only story'],
    ['/ghost/locked', 'Ghost members-only post (paywall box inside the article)'],
  ]) {
    await openTab(`${SITE}${pathName}`);
    ({ popup } = await openPopupFor(`${SITE}${pathName}`));
    await popup.waitForFunction(() => !document.querySelector('#btn-send').disabled);
    const n = await sentCount();
    await popup.click('#btn-send');
    await popup.waitForSelector('#state-error:not(.hidden)', { timeout: 10000 });
    check(`${label}: refused with the paywall message and a Send anyway button, nothing sent`,
      (await text(popup, '#error-message')).includes('behind a paywall or sign-in') && (await sentCount()) === n
      && (await visible(popup, '#btn-anyway')) && (await text(popup, '#btn-anyway')) === 'Send anyway');
    if (pathName === '/news/paid-ld') {
      await popup.click('#btn-anyway');
      await popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 });
      check('paywall refusal: Send anyway sends the part that is showing',
        (await sentCount()) === n + 1 && parseMail((await lastSent()).body).html.includes('Teaser paragraph 3'));
    }
    await popup.close();
  }

  // ── Not an article: refused after extraction, with Send anyway ──
  for (const [pathName, label] of [['/', 'news homepage'], ['/news/latest', 'section page of headline links']]) {
    await openTab(`${SITE}${pathName}`);
    ({ popup } = await openPopupFor(`${SITE}${pathName}`));
    await popup.waitForFunction(() => !document.querySelector('#btn-send').disabled);
    const n = await sentCount();
    await popup.click('#btn-send');
    await popup.waitForSelector('#state-error:not(.hidden)', { timeout: 10000 });
    check(`${label}: says it isn't a single article, offers Send anyway, nothing sent`,
      (await text(popup, '#error-message')).includes("doesn't look like a single article")
      && (await visible(popup, '#btn-anyway')) && (await sentCount()) === n);
    if (pathName === '/news/latest') {
      await popup.click('#btn-anyway');
      await popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 });
      check('not-an-article refusal: Send anyway sends what was found', (await sentCount()) === n + 1);
    }
    await popup.close();
  }

  // ── WordPress plain permalink (/?p=42): an article, and its queue identity keeps ?p=42 ──
  await openTab(`${SITE}/?p=42&utm_source=feed`);
  ({ popup } = await openPopupFor(`${SITE}/?p=42&utm_source=feed`));
  await waitTitle(popup, 'Plain Permalink Post');
  check('WordPress /?p=42 post detected as an article', !(await popup.locator('#btn-add-queue').isDisabled()));
  await popup.click('#btn-add-queue');
  await popup.waitForFunction(() => document.querySelector('#queue-count').textContent === '1 article in queue');
  const wpUrl = await sw.evaluate(async () => (await chrome.storage.local.get('queue')).queue[0].url);
  check('queued article keeps the identifying ?p=42 and drops tracking', wpUrl === `${SITE}/?p=42`, wpUrl);
  await popup.close();

  // ── Queue image budget: a queue already holding a full budget of inlined images ──
  await sw.evaluate(({ site }) => chrome.storage.local.set({ queue: [{
    title: 'Huge', url: `${site}/huge`,
    content: `<p>Huge</p><img src="data:image/png;base64,${'A'.repeat(20 * 1024 * 1024)}" data-s2k-src="${site}/img/huge.png">`,
  }] }), { site: SITE });
  ({ popup } = await openPopupFor(`${SITE}/blog/free-post`));
  await waitTitle(popup, 'A Free Blog Post');
  await popup.waitForFunction(() => !document.querySelector('#btn-add-queue').disabled);
  await popup.click('#btn-add-queue');
  await popup.waitForFunction(() => document.querySelector('#queue-count').textContent === '2 articles in queue');
  const queued = await sw.evaluate(async () => (await chrome.storage.local.get('queue')).queue[1].content);
  check('queue over its image budget: the new article keeps image links instead of inlined copies',
    queued.includes(`src="${SITE}/img/photo.png"`) && !queued.includes('src="data:'));
  await sw.evaluate(() => chrome.storage.local.set({ queue: [] }));
  await popup.close();

  // A page the extension may not read (here: no permission; in real use chrome://, the Web Store, PDFs).
  await openTab('https://example.org/');
  ({ popup } = await openPopupFor('https://example.org/'));
  await waitTitle(popup, "Chrome doesn't let extensions read this page");
  check('unreadable page: friendly message, buttons disabled', await popup.locator('#btn-send').isDisabled());
  check('settings reachable from a non-article page', await visible(popup, '#btn-settings'));
  await popup.close();

  ({ popup } = await openPopupFor(null));
  await waitTitle(popup, "Chrome doesn't let extensions read this page");
  check('no readable tab (chrome:// etc.): friendly message', true);
  await popup.close();

  // ── Settings: "Include images from any site" (chrome.permissions stubbed) ──
  for (const answer of [true, false]) {
    ({ popup } = await openPopupFor(null, {
      arg: answer,
      fn: (grant) => {
        window.__permCalls = [];
        let granted = false;
        chrome.permissions.contains = async () => granted;
        chrome.permissions.request = async (p) => { window.__permCalls.push(p); granted = grant; return grant; };
        chrome.permissions.remove = async () => { granted = false; return true; };
      },
    }));
    await popup.click('#btn-settings');
    check(`images toggle starts off (${answer ? 'grant' : 'decline'} run)`, !(await popup.locator('#input-all-images').isChecked()));
    await popup.click('#input-all-images');
    await popup.waitForFunction(() => !document.querySelector('#images-msg').classList.contains('hidden'));
    const calls = await popup.evaluate(() => window.__permCalls);
    const asked = calls.length === 1 && JSON.stringify(calls[0]) === JSON.stringify({ origins: ['<all_urls>'] });
    if (answer) {
      check('images toggle: asks Chrome for <all_urls> and stays on when granted',
        asked && (await popup.locator('#input-all-images').isChecked()) && (await text(popup, '#images-msg')).includes('will be included'));
      await popup.click('#input-all-images');
      check('images toggle: turning it off removes the permission', !(await popup.locator('#input-all-images').isChecked()));
    } else {
      check('images toggle: declined leaves it off with a plain message',
        asked && !(await popup.locator('#input-all-images').isChecked()) && (await text(popup, '#images-msg')).includes('Not turned on'));
    }
    await popup.close();
  }

  // The popup can close while Chrome's permission prompt is up, so the request
  // never answers. A reopened popup must read the real state, and a change made
  // elsewhere (chrome://extensions) must show while the popup is open.
  ({ popup } = await openPopupFor(null, {
    arg: null,
    fn: () => {
      window.__granted = true;
      chrome.permissions.contains = async () => window.__granted;
      chrome.permissions.onRemoved.addListener = (fn) => { window.__onRemoved = fn; };
    },
  }));
  await popup.click('#btn-settings');
  await popup.waitForFunction(() => document.querySelector('#input-all-images').checked);
  check('reopened popup shows images toggle on when the permission was granted', true);
  await popup.evaluate(() => { window.__granted = false; window.__onRemoved({ origins: ['<all_urls>'] }); });
  await popup.waitForFunction(() => !document.querySelector('#input-all-images').checked);
  check('permission removed elsewhere: toggle turns off while the popup is open', true);
  await popup.close();

  // ── Nothing to read ──
  await openTab('https://jane.substack.com/p/locked');
  ({ popup } = await openPopupFor('https://jane.substack.com/p/locked'));
  await popup.waitForFunction(() => !document.querySelector('#btn-send').disabled);
  let before = await sentCount();
  await popup.click('#btn-send');
  await popup.waitForSelector('#state-error:not(.hidden)', { timeout: 10000 });
  check('empty extraction: clear message, no Send anyway, nothing sent',
    (await text(popup, '#error-message')).includes("Couldn't find the article text") && (await sentCount()) === before
    && !(await visible(popup, '#btn-anyway')));
  await popup.close();

  await openTab('https://jane.substack.com/p/preview');
  ({ popup } = await openPopupFor('https://jane.substack.com/p/preview'));
  await popup.waitForFunction(() => !document.querySelector('#btn-send').disabled);
  before = await sentCount();
  await popup.click('#btn-send');
  await popup.waitForSelector('#state-error:not(.hidden)', { timeout: 10000 });
  check('Substack paid-post preview: refused with the paywall message, nothing sent',
    (await text(popup, '#error-message')).includes('behind a paywall or sign-in') && (await sentCount()) === before);
  await popup.close();

  // ── Network failure, then Chrome sign-in turned off ──
  ({ popup } = await openPopupFor('https://jane.substack.com/p/second'));
  await popup.waitForFunction(() => !document.querySelector('#btn-send').disabled);
  await mockGmail('network');
  await popup.click('#btn-send');
  await popup.waitForSelector('#state-error:not(.hidden)', { timeout: 10000 });
  check('network failure: clear message', (await text(popup, '#error-message')).includes('internet connection'));
  await popup.click('#btn-dismiss-error');
  await popup.close();

  // ── No Chrome account (Comet, Brave, Edge, Arc): Google's web sign-in instead ──
  const resetAuth = () => sw.evaluate(async () => {
    await chrome.storage.session.remove('gmailToken');
    await chrome.storage.local.remove('gmailAuth');
    self.__flows = [];
    self.__chromeAuthCalls = 0;
  });
  const authLog = () => sw.evaluate(() => ({ flows: self.__flows, chromeCalls: self.__chromeAuthCalls }));
  const sendSecond = async () => {
    ({ popup } = await openPopupFor('https://jane.substack.com/p/second'));
    await popup.waitForFunction(() => !document.querySelector('#btn-send').disabled);
    await popup.click('#btn-send');
    await popup.waitForSelector('#state-sent:not(.hidden), #state-error:not(.hidden)', { timeout: 10000 });
  };

  await mockGmail('signin_off');
  await sw.evaluate(() => {
    self.__expiresIn = 60; // expires at once (renewal margin), so the next send renews
    // Chrome for Testing doesn't call itself Google Chrome; present as Google
    // Chrome so Chrome's own sign-in is tried (and fails) first, as in Comet
    // if it reports the Google Chrome brand.
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }] } });
  });
  await resetAuth();
  let n = await sentCount();
  await sendSecond();
  let log = await authLog();
  check('"The user turned off browser signin": web sign-in runs and exactly one email is sent',
    (await visible(popup, '#state-sent')) && (await sentCount()) === n + 1
    && (await lastSent()).headers.Authorization === 'Bearer web-token-1'
    && log.chromeCalls === 1 && log.flows.length === 1 && log.flows[0].interactive === true
    && log.flows[0].clientId === 'e2e-web-client.apps.googleusercontent.com',
    `chrome sign-in tried ${log.chromeCalls}x, flows ${JSON.stringify(log.flows)}`);
  await popup.close();

  await sw.evaluate(() => { self.__flows = []; self.__expiresIn = 3600; });
  n = await sentCount();
  await sendSecond();
  log = await authLog();
  check('next send renews silently (prompt=none, remembered account), no sign-in window',
    (await visible(popup, '#state-sent')) && (await sentCount()) === n + 1
    && log.flows.length === 1 && log.flows[0].interactive === false && log.flows[0].prompt === 'none'
    && log.flows[0].hint === 'reader@gmail.com' && (await lastSent()).headers.Authorization === 'Bearer web-token-1',
    JSON.stringify(log.flows));
  await popup.close();

  await mockGmail('web_cancel');
  await resetAuth();
  n = await sentCount();
  await sendSecond();
  check('user closes the Google sign-in window: "sign-in was cancelled", nothing sent',
    (await visible(popup, '#state-error')) && (await text(popup, '#error-message')).includes('sign-in was cancelled')
    && (await sentCount()) === n, await text(popup, '#error-message'));
  await popup.close();
  await resetAuth();

  // ── Popup closed mid-send: send finishes, reopened popup tracks it ──
  await mockGmail('slow');
  ({ popup } = await openPopupFor('https://jane.substack.com/p/second'));
  await popup.waitForFunction(() => !document.querySelector('#btn-send').disabled);
  const n0 = await sentCount();
  await popup.click('#btn-send');
  await popup.waitForTimeout(200);
  await popup.close();
  ({ popup } = await openPopupFor('https://jane.substack.com/p/second'));
  const sawSending = await popup.waitForSelector('#state-loading:not(.hidden)', { timeout: 2000 }).then(() => true, () => false);
  await popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 });
  check('popup closed mid-send: send completes, reopened popup tracks it', sawSending && (await sentCount()) === n0 + 1);
  await popup.close();

  // ── Settings change applies to the next send ──
  await mockGmail('ok');
  ({ popup } = await openPopupFor('https://jane.substack.com/p/second'));
  await popup.waitForFunction(() => !document.querySelector('#btn-send').disabled);
  await popup.click('#btn-settings');
  await popup.fill('#input-kindle-email-settings', 'other@kindle.com');
  await popup.click('#btn-update-email');
  await popup.waitForFunction(() => document.querySelector('#settings-msg').textContent === 'Saved');
  await popup.click('#btn-send');
  await popup.waitForSelector('#state-sent:not(.hidden)', { timeout: 10000 });
  check('updated Kindle address used immediately', parseMail((await lastSent()).body).headers.to === 'other@kindle.com');
  await popup.close();

  check('no console errors in popup', popupErrors.length === 0, popupErrors.join(' | '));
  check('no console errors in service worker', swErrors.length === 0, swErrors.join(' | '));
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exitCode = 2;
});
