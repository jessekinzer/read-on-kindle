'use strict';

// Live corpus check: real pages, real network, the shipped extension in Chromium
// with JavaScript on, content.js injected through chrome.scripting exactly as the
// popup does. Not part of `npm test` because it depends on third-party sites.
//
//   npm run test:live              all of tests/live/corpus.json
//   npm run test:live -- clay      only entries whose URL contains "clay"
//
// Corpus entries: { url, stack, expect: "send" | "gated" | "not_article",
// title?: expected substring, author?: expected substring, known?: why a
// miss is accepted for now }. Unreachable pages (bot walls, HTTP errors) are
// reported as SKIP, not failures.
//
// Nothing is emailed: the popup and the service worker's send path are not used.
// The test copy of the extension gets "<all_urls>" host access, standing in for
// the activeTab grant Chrome gives when the toolbar icon is clicked.

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SHIPPED_FILES, findChrome, stageShippedExtension } = require('../e2e/chrome');

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus.json'), 'utf8'));
const filter = process.argv[2];
const entries = filter ? corpus.filter((e) => e.url.includes(filter)) : corpus;
const PLATFORMS = /^(substack|medium|wordpress|ghost|webflow|framer|hubspot|blogger|tumblr|wix|squarespace|beehiiv)$/i;
const CONCURRENCY = 4;

async function inspect(context, sw, entry) {
  const page = await context.newPage();
  try {
    const res = await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const status = res ? res.status() : 0;
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500); // let client-rendered pages settle
    if (status >= 400) return { unreachable: `HTTP ${status}` };
    const finalUrl = page.url();
    return await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url) || tabs.reduce((a, b) => (a.id > b.id ? a : b));
      const target = { tabId: tab.id };
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
      const [probe] = await chrome.scripting.executeScript({ target, func: () => globalThis.__s2k.probe() });
      await chrome.scripting.executeScript({ target, files: ['lib/Readability.js', 'content.js'] });
      const [ex] = await chrome.scripting.executeScript({
        target,
        func: async () => {
          const t0 = Date.now();
          const r = await globalThis.__s2k.extract();
          const doc = new DOMParser().parseFromString(r.article ? r.article.content : '', 'text/html');
          const imgs = Array.from(doc.querySelectorAll('img'));
          const textLen = doc.body.textContent.trim().length || 1;
          const links = Array.from(doc.querySelectorAll('a'));
          return {
            links: links.length,
            linkShare: Math.round((100 * links.reduce((n, a) => n + a.textContent.trim().length, 0)) / textLen),
            success: r.success, code: r.code || '', reasons: r.reasons || [],
            title: r.article ? r.article.title : '', byline: r.article ? r.article.byline : '',
            textLen: doc.body.textContent.trim().length,
            images: imgs.length, inlined: imgs.filter((i) => (i.getAttribute('src') || '').startsWith('data:')).length,
            ms: Date.now() - t0,
          };
        },
      });
      return { probe: probe.result, ...ex.result };
    }, finalUrl);
  } catch (err) {
    return { unreachable: String(err.message || err).split('\n')[0].slice(0, 80) };
  } finally {
    await page.close().catch(() => {});
  }
}

function judge(entry, r) {
  if (r.unreachable) return { verdict: 'SKIP', why: r.unreachable };
  const why = [];
  const outcome = r.success ? 'send' : r.code === 'gated' ? 'gated' : (r.code === 'not_article' || r.code === 'empty') ? 'not_article' : r.code;
  if (outcome !== entry.expect) why.push(`got ${outcome}${r.reasons.length ? ` (${r.reasons.join(',')})` : ''}`);
  if (entry.expect === 'send') {
    if (entry.title && !r.title.toLowerCase().includes(entry.title.toLowerCase())) why.push(`title "${r.title}"`);
    if (PLATFORMS.test(r.byline.trim()) || PLATFORMS.test((r.probe.byline || '').trim())) why.push(`platform as author "${r.byline}"`);
    if (entry.author && !r.byline.toLowerCase().includes(entry.author.toLowerCase())) why.push(`author "${r.byline}"`);
    if (entry.author && !(r.probe.byline || '').toLowerCase().includes(entry.author.toLowerCase())) why.push(`popup author "${r.probe.byline}"`);
  }
  if (why.length && entry.known) return { verdict: 'KNOWN', why: `${why.join('; ')} [known: ${entry.known}]` };
  return { verdict: why.length ? 'FAIL' : 'PASS', why: why.join('; ') };
}

async function main() {
  const extDir = stageShippedExtension(SHIPPED_FILES, ['<all_urls>']);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 's2k-live-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChrome(),
    headless: !process.env.S2K_HEADED,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const rows = [];
  try {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (next < entries.length) {
        const entry = entries[next++];
        const r = await inspect(context, sw, entry);
        const j = judge(entry, r);
        rows.push({ entry, r, j });
        console.log(`${j.verdict}  [${entry.expect}] ${entry.url}${j.why ? `  -> ${j.why}` : ''}`);
      }
    }));
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  }

  console.log('\nverdict | expect | got | stack | title | author | text | links (% of text) | images (inlined) | url');
  for (const { entry, r, j } of entries.map((e) => rows.find((x) => x.entry === e))) {
    const got = r.unreachable ? '-' : r.success ? 'send' : r.code;
    console.log([j.verdict, entry.expect, got, entry.stack, (r.title || '').slice(0, 50), r.byline || '', r.textLen || 0,
      `${r.links || 0} (${r.linkShare || 0}%)`, `${r.images || 0} (${r.inlined || 0})`, entry.url].join(' | '));
  }
  const count = (v) => rows.filter((x) => x.j.verdict === v).length;
  console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('KNOWN')} known misses, `
    + `${count('SKIP')} unreachable, of ${rows.length}`);
  process.exitCode = count('FAIL') ? 1 : 0;
}

main().catch((err) => {
  console.error('Live check crashed:', err);
  process.exitCode = 2;
});
