'use strict';

// Service worker. Owns the whole send pipeline (format, inline images, Gmail
// auth, send, queue cleanup) so a send keeps going if the popup closes, which
// happens whenever Google's sign-in window opens on the first send.

/* global importScripts, getAuthToken, removeCachedAuthToken, sendEmail, uint8ArrayToBase64 */
if (typeof importScripts === 'function') {
  importScripts('gmail.js');
} else if (typeof require === 'function') {
  Object.assign(globalThis, require('./gmail.js'));
}

const STATUS_KEY = 'sendStatus';
const KINDLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp'];
const MAX_IMAGE_BYTES_TOTAL = 20 * 1024 * 1024; // keeps the message well under Gmail's 35 MB cap

// ─── HTML formatting ──────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHref(url) {
  return /^https?:\/\//i.test(String(url || '')) ? escHtml(url) : '';
}

function metaLine(a) {
  const meta = [a.byline, a.date].filter(Boolean).map(escHtml).join(' · ');
  const href = safeHref(a.url);
  const link = href ? `<a href="${href}">${href}</a>` : '';
  return [meta, link].filter(Boolean).join(' · ');
}

const BODY_STYLE =
  'font-family: Georgia, serif; font-size: 16px; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;';
const IMG_STYLE = '<style>img { max-width: 100%; height: auto; }</style>';

function formatArticleHtml(article) {
  const title = article.title || 'Untitled';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escHtml(title)}</title>
${IMG_STYLE}
</head>
<body style="${BODY_STYLE}">
  <h1 style="font-size: 24px; margin-bottom: 8px;">${escHtml(title)}</h1>
  <p style="font-size: 14px; color: #666; margin-bottom: 16px;">${metaLine(article)}</p>
  <hr style="border: none; border-top: 1px solid #ddd; margin-bottom: 20px;">
  ${article.content || ''}
</body>
</html>`;
}

function longDate(d = new Date()) {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function digestSubject(d = new Date()) {
  return `Reading Digest, ${longDate(d)}`;
}

function formatDigestHtml(articles, d = new Date()) {
  const today = longDate(d);
  const toc = articles.map((a, i) =>
    `<li><a href="#article-${i + 1}">${escHtml(a.title || 'Untitled')}</a>${a.byline ? `, ${escHtml(a.byline)}` : ''}</li>`
  ).join('\n');

  const bodies = articles.map((a, i) => `<div id="article-${i + 1}" style="margin-bottom: 48px;">
  <h2 style="font-size: 22px; margin-bottom: 8px;">${escHtml(a.title || 'Untitled')}</h2>
  <p style="font-size: 14px; color: #666; margin-bottom: 16px;">${metaLine(a)}</p>
  <hr style="border: none; border-top: 1px solid #ddd; margin-bottom: 20px;">
  ${a.content || ''}
</div>`).join('\n<hr style="border: none; border-top: 2px solid #ccc; margin: 32px 0;">\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escHtml(digestSubject(d))}</title>
${IMG_STYLE}
</head>
<body style="${BODY_STYLE}">
  <h1 style="font-size: 26px; margin-bottom: 6px;">Reading Digest</h1>
  <p style="font-size: 14px; color: #888; margin-bottom: 20px;">${escHtml(today)} · ${articles.length} article${articles.length !== 1 ? 's' : ''}</p>
  <hr style="border: none; border-top: 1px solid #ddd; margin-bottom: 16px;">
  <ol style="padding-left: 20px; margin-bottom: 32px; line-height: 1.8;">
    ${toc}
  </ol>
  <hr style="border: none; border-top: 2px solid #ccc; margin-bottom: 32px;">
  ${bodies}
</body>
</html>`;
}

/**
 * Human-readable attachment filename. Kindle shows the filename (minus
 * extension) as the document title, so keep spaces and casing and only strip
 * characters that are invalid in filenames or unsafe in MIME headers. Common
 * typography is mapped to ASCII first, so "Don’t — Café" becomes
 * "Don't - Cafe" rather than "Don t Caf".
 */
const charClass = (...codes) => new RegExp(`[${String.fromCharCode(...codes)}]`, 'g');
const SINGLE_QUOTES = charClass(0x2018, 0x2019, 0x201A, 0x201B, 0x2032);
const DOUBLE_QUOTES = charClass(0x201C, 0x201D, 0x201E, 0x201F, 0x2033);
const DASHES = charClass(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212);
const ELLIPSIS = charClass(0x2026);
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36F)}]`, 'g');

function toFilename(str) {
  return String(str || '')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(ELLIPSIS, '...')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'article';
}

// ─── Image inlining ───────────────────────────────────────────────────────────

const IMG_SRC_RE = /(<img\b[^>]*?\ssrc=")([^"]+)(")/gi;

function decodeAttr(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Kindle can't show WebP or AVIF, which many sites serve whatever we ask for.
 * Re-encode those as JPEG (on white, since JPEG has no transparency).
 * Returns null for SVG, non-images, or when decoding isn't available.
 */
async function reencodeAsJpeg(type, res) {
  if (!type.startsWith('image/') || type.includes('svg')) return null;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  const bitmap = await createImageBitmap(new Blob([await res.arrayBuffer()], { type }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx2d = canvas.getContext('2d');
  ctx2d.fillStyle = '#fff';
  ctx2d.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx2d.drawImage(bitmap, 0, 0);
  bitmap.close();
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return `data:image/jpeg;base64,${uint8ArrayToBase64(new Uint8Array(await jpeg.arrayBuffer()))}`;
}

async function fetchAsDataUri(url, fetchFn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      // Ask for formats Kindle can render (Substack's CDN otherwise may serve WebP).
      headers: { Accept: 'image/jpeg,image/png,image/gif;q=0.9,*/*;q=0.5' },
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (KINDLE_IMAGE_TYPES.includes(type)) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      return `data:${type};base64,${uint8ArrayToBase64(bytes)}`;
    }
    return await reencodeAsJpeg(type, res);
  } catch (_) {
    return null; // timeout or network failure: keep the remote URL
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keep images that the page already inlined (content.js marks them with
 * data-s2k-src) within the size budget. A digest joins several articles, each
 * of which may carry up to a full budget of images, so past the budget the
 * later images go back to their original links. Returns the HTML without the
 * data-s2k-src markers.
 */
function capInlinedImages(html, maxTotalBytes = MAX_IMAGE_BYTES_TOTAL) {
  let total = 0;
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\ssrc="(data:[^"]*)"/i.exec(tag);
    const original = /\sdata-s2k-src="([^"]*)"/i.exec(tag);
    let out = tag;
    if (src) {
      if (original && total + src[1].length > maxTotalBytes) {
        out = out.replace(src[0], ` src="${original[1]}"`);
      } else {
        total += src[1].length;
      }
    }
    return original ? out.replace(original[0], '') : out;
  });
}

/**
 * Replace remote <img src> URLs with data URIs so the document renders on Kindle
 * without network access. Images are fetched in parallel (bounded), each with a
 * timeout; any image that fails, times out, is an unsupported type, or would push
 * the total over the size budget keeps its original URL. Never throws.
 *
 * Images already inlined by the page (same-site images, see content.js) count
 * toward the size budget. Pass opts.stats = {} to learn how many images were
 * left as remote links (stats.remote).
 *
 * A remote link is kept rather than dropped: Amazon's converter may still fetch
 * it, and at worst the image is simply missing on the Kindle.
 */
async function inlineImages(html, opts = {}) {
  const {
    fetchFn = fetch,
    timeoutMs = 15000,
    maxTotalBytes = MAX_IMAGE_BYTES_TOTAL,
    concurrency = 6,
    stats = {},
  } = opts;
  stats.remote = 0;

  const urls = [];
  const seen = new Set();
  for (const m of html.matchAll(IMG_SRC_RE)) {
    const url = decodeAttr(m[2]);
    if (/^https?:\/\//i.test(url) && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  if (urls.length === 0) return html;

  const inlined = new Map();
  let total = 0;
  for (const m of html.matchAll(/src="(data:[^"]*)"/g)) total += m[1].length;
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const url = urls[next++];
      const dataUri = await fetchAsDataUri(url, fetchFn, timeoutMs);
      if (dataUri && total + dataUri.length <= maxTotalBytes) {
        total += dataUri.length;
        inlined.set(url, dataUri);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  stats.remote = urls.length - inlined.size;

  return html.replace(IMG_SRC_RE, (all, before, src, after) => {
    const dataUri = inlined.get(decodeAttr(src));
    return dataUri ? before + dataUri + after : all;
  });
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Turn auth, network, and Gmail API failures into a message a reader can act on. */
function friendlyError(err) {
  const msg = String((err && err.message) || err || '');
  const lower = msg.toLowerCase();
  const status = err && err.status;

  if (err && err.code === 'timeout') {
    return 'Gmail took too long to respond. Check your connection and try again.';
  }
  if ((err && err.code === 'network') || lower.includes('failed to fetch') || lower.includes('networkerror')) {
    return "Couldn't reach Gmail. Check your internet connection and try again.";
  }
  if (err && err.code === 'web_auth_unconfigured') {
    return "Gmail sign-in for this browser isn't set up yet in this copy of the extension. "
      + 'It works in Google Chrome when you are signed in to Chrome.';
  }
  if (err && err.code === 'state_mismatch') {
    return "Google sign-in couldn't be verified. Click Send again to sign in.";
  }
  if ((err && err.code === 'signin_off') || /browser ?sign-?in/.test(lower)) {
    return "Couldn't sign in to Google. Click Send again and sign in with the Google account you want to send from.";
  }
  if (lower.includes('did not approve') || lower.includes('cancel') || lower.includes('closed by the user')
      || lower.includes('oauth2 not granted')) {
    return 'Gmail sign-in was cancelled. Click Send again and allow access to send email.';
  }
  if (lower.includes('bad client id') || lower.includes('invalid_client')
      || lower.includes('invalid oauth2 client')) {
    return "Gmail sign-in isn't set up for this copy of the extension. Install it from the Chrome Web Store, "
      + "or ask the developer to match the OAuth client to this extension's ID.";
  }
  if (err && err.code === 'insufficient_scope') {
    return 'Gmail permission to send email was not given. Click Send again and, on the Google screen, '
      + 'tick the box that lets Substack to Kindle send email.';
  }
  if (status === 401) return 'Your Gmail sign-in expired. Click Send again to sign in.';
  if (status === 400 && /recipient|to header|address/.test(lower)) {
    return 'Gmail did not accept your Kindle address. Check it in Settings (the gear icon) and try again.';
  }
  if (status === 403) return `Gmail refused to send: ${msg || 'permission denied'}.`;
  if (status === 413 || lower.includes('too large') || lower.includes('exceeds')) {
    return 'This is too large to email. Try sending fewer articles at once.';
  }
  if (status === 429) return 'Gmail is rate limiting sends. Wait a minute and try again.';
  if (status >= 500) return 'Gmail had a temporary problem. Try again in a moment.';
  return msg || 'Failed to send. Please try again.';
}

// ─── Status (read by the popup, survives the popup closing) ──────────────────

async function setStatus(status) {
  const value = { ...status, at: Date.now() };
  try {
    await chrome.storage.local.set({ [STATUS_KEY]: value });
  } catch (_) { /* status is best effort */ }
  try {
    if (status.state === 'error') {
      await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
      await chrome.action.setBadgeText({ text: '!' });
    } else if (status.state === 'sent') {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (_) { /* badge is cosmetic */ }
  return value;
}

// ─── Send pipeline ────────────────────────────────────────────────────────────

let inFlight = null;

/** Gmail send with one automatic retry when the cached token has expired or been revoked. */
async function sendWithAuth(to, subject, html, filename, token) {
  try {
    return await sendEmail(token, to, subject, html, filename);
  } catch (err) {
    if (err.status === 403 && /insufficient (authentication )?(scopes|permission)/i.test(err.message)) {
      // The user unticked "send email" on Google's consent screen. Forget the
      // token so the next Send asks again instead of failing the same way.
      await removeCachedAuthToken(token);
      err.code = 'insufficient_scope';
      throw err;
    }
    if (err.status !== 401) throw err;
    await removeCachedAuthToken(token);
    const fresh = await getAuthToken();
    return sendEmail(fresh, to, subject, html, filename);
  }
}

async function runSend(request) {
  const { kindleEmail, queue } = await chrome.storage.local.get(['kindleEmail', 'queue']);
  if (!kindleEmail) {
    return { ok: false, code: 'no_email', error: 'Add your Kindle email address first.' };
  }

  let html;
  let subject;
  let label;
  let sentUrls = [];

  if (request.mode === 'digest') {
    const items = Array.isArray(queue) ? queue : [];
    if (items.length === 0) return { ok: false, code: 'empty_queue', error: 'Your queue is empty.' };
    html = formatDigestHtml(items);
    subject = digestSubject();
    label = `Digest sent, ${items.length} article${items.length !== 1 ? 's' : ''}`;
    sentUrls = items.map((a) => a.url);
  } else {
    const article = request.article;
    if (!article || !article.content) {
      return { ok: false, code: 'no_article', error: "Couldn't find the article text on this page. Make sure the whole article is showing, then try again." };
    }
    html = formatArticleHtml(article);
    subject = article.title || 'Article';
    label = 'Sent to your Kindle';
  }

  await setStatus({ state: 'sending', stage: 'Preparing images…', label });

  // Auth and image fetching run at the same time. Auth may open Google's
  // sign-in window on first use; images download while the user approves.
  // A failed or cancelled sign-in is reported right away, without waiting
  // for the images.
  const imageStats = {};
  const [token, inlinedHtml] = await Promise.all([
    getAuthToken(),
    inlineImages(capInlinedImages(html), { stats: imageStats }),
  ]);

  await setStatus({ state: 'sending', stage: 'Sending…', label });
  await sendWithAuth(kindleEmail, subject, inlinedHtml, toFilename(subject) + '.html', token);
  const note = await missingImagesNote(imageStats.remote);

  if (sentUrls.length) {
    // Remove only what was sent; anything queued during the send stays.
    const { queue: latest } = await chrome.storage.local.get(['queue']);
    const sent = new Set(sentUrls);
    await chrome.storage.local.set({ queue: (Array.isArray(latest) ? latest : []).filter((a) => !sent.has(a.url)) });
  }

  return note ? { ok: true, label, note } : { ok: true, label };
}

/**
 * When some images could not be downloaded and the user hasn't allowed images
 * from any site, say so and point at the setting. Otherwise nothing.
 */
async function missingImagesNote(remote) {
  if (!remote) return '';
  let allSites = false;
  try {
    allSites = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch (_) { /* treat as not granted */ }
  if (allSites) return '';
  const n = remote === 1 ? '1 image' : `${remote} images`;
  return `${n} couldn't be included. To include images stored on other sites next time, turn on `
    + '"Include images from any site" in Settings (the gear icon).';
}

/**
 * Entry point for a send. Rejects a second send while one is running, keeps the
 * service worker alive for long uploads, and always ends with a sent or error
 * status in storage so the popup never shows a silent hang.
 */
async function handleSend(request) {
  if (inFlight) {
    return { ok: false, code: 'busy', error: 'A send is already in progress.' };
  }

  // Calling an extension API resets the service worker idle timer, so a slow
  // upload (over 30 seconds) is not cut off.
  const keepAlive = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) { /* ignore */ }
  }, 20000);

  inFlight = (async () => {
    try {
      const result = await runSend(request);
      if (result.ok) await setStatus({ state: 'sent', label: result.label, note: result.note || '', seen: false });
      else await setStatus({ state: 'error', message: result.error, seen: false });
      return result;
    } catch (err) {
      const message = friendlyError(err);
      await setStatus({ state: 'error', message, seen: false });
      return { ok: false, code: 'send_failed', error: message };
    }
  })();

  try {
    return await inFlight;
  } finally {
    clearInterval(keepAlive);
    inFlight = null;
  }
}

async function getStatus() {
  if (inFlight) {
    const { [STATUS_KEY]: status } = await chrome.storage.local.get([STATUS_KEY]);
    return status && status.state === 'sending' ? status : { state: 'sending', stage: 'Sending…' };
  }
  const { [STATUS_KEY]: status } = await chrome.storage.local.get([STATUS_KEY]);
  if (status && status.state === 'sending') {
    // The worker restarted mid-send (nothing is in flight in this instance).
    return setStatus({ state: 'error', message: "The last send didn't finish. Please try again.", seen: false });
  }
  return status || null;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message) return false;
    if (message.type === 'send') {
      handleSend(message).then(sendResponse);
      return true;
    }
    if (message.type === 'getStatus') {
      getStatus().then(sendResponse, () => sendResponse(null));
      return true;
    }
    return false;
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    escHtml,
    formatArticleHtml,
    formatDigestHtml,
    digestSubject,
    toFilename,
    capInlinedImages,
    inlineImages,
    friendlyError,
    handleSend,
    getStatus,
  };
}
