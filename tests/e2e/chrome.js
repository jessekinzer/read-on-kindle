'use strict';

// Shared by the e2e suite and the live corpus check: which Chromium to run,
// and a temp copy of the shipped extension with extra host permissions.

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// The same files the Chrome Web Store ZIP contains (PUBLISH_CHECKLIST.md).
const SHIPPED_FILES = [
  'manifest.json', 'background.js', 'popup.html', 'popup.css', 'popup.js', 'content.js', 'gmail.js',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png', 'lib/Readability.js',
];

/** S2K_CHROME if set, else Playwright's own Chromium, else the newest Chrome for Testing in Playwright's cache. */
function findChrome() {
  if (process.env.S2K_CHROME) return process.env.S2K_CHROME;
  try {
    const own = chromium.executablePath();
    if (own && fs.existsSync(own)) return own;
  } catch (_) { /* not installed */ }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright'));
  const candidates = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
  ];
  const dirs = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const dir of dirs) {
    for (const rel of candidates) {
      const exe = path.join(cache, dir, rel);
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error('No Chromium found. Run `npx playwright install chromium` once, or set S2K_CHROME.');
}

/** Copy the shipped files to a temp folder and add host permissions that stand in for activeTab. */
function stageShippedExtension(files, extraHosts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2k-ext-'));
  for (const rel of files) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) throw new Error(`Shipped file is missing: ${rel}`);
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(dir, rel));
  }
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions.push(...extraHosts);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

module.exports = { ROOT, SHIPPED_FILES, findChrome, stageShippedExtension };
