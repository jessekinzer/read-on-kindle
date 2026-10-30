'use strict';

// Popup UI. Reads the page through content.js (injected on demand) and hands
// sends to the service worker (background.js), which keeps working if the
// popup closes.

const KINDLE_EMAIL_RE = /^[^\s@]+@(free\.)?kindle\.(com|cn)$/i;
const CANT_READ_MSG = "Chrome doesn't let extensions read this page. Open an article on a website, then click the icon again.";
const ALL_SITES = { origins: ['<all_urls>'] };

const $ = (id) => document.getElementById(id);

const states = {
  onboarding: $('state-onboarding'),
  main:       $('state-main'),
  loading:    $('state-loading'),
  error:      $('state-error'),
  sent:       $('state-sent'),
};

const el = {
  emailOnboarding: $('input-kindle-email-onboarding'),
  errorOnboarding: $('error-onboarding'),

  btnSettings:     $('btn-settings'),
  settingsPanel:   $('settings-panel'),
  emailSettings:   $('input-kindle-email-settings'),
  settingsMsg:     $('settings-msg'),
  allImages:       $('input-all-images'),
  imagesMsg:       $('images-msg'),

  banner:          $('status-banner'),
  articleTitle:    $('article-title'),
  articleAuthor:   $('article-author'),
  btnSend:         $('btn-send'),
  btnAddQueue:     $('btn-add-queue'),
  actionMsg:       $('action-msg'),
  queueCount:      $('queue-count'),
  btnSendDigest:   $('btn-send-digest'),

  loadingText:     $('loading-text'),
  errorMessage:    $('error-message'),
  btnRetry:        $('btn-retry'),
  btnAnyway:       $('btn-anyway'),
  btnDismissError: $('btn-dismiss-error'),
  sentMsg:         $('sent-msg'),
  sentNote:        $('sent-note'),
  btnSentDone:     $('btn-sent-done'),
};

const ctx = {
  tabId: null,
  hasArticle: false,
  extractPromise: null,
  queueLength: 0,
  busy: false,
  retry: null,
  anyway: null,
  observingSend: false, // popup reopened while a send was already running
};

// ─── Small helpers ────────────────────────────────────────────────────────────

function showState(name) {
  Object.entries(states).forEach(([key, node]) => node.classList.toggle('hidden', key !== name));
}

function flash(node, text, kind = 'info', ms = 2500) {
  node.textContent = text;
  node.className = `${kind}-inline`;
  clearTimeout(node._timer);
  if (ms) node._timer = setTimeout(() => node.classList.add('hidden'), ms);
}

function updateButtons() {
  el.btnSend.disabled = ctx.busy || !ctx.hasArticle;
  el.btnAddQueue.disabled = ctx.busy || !ctx.hasArticle;
  el.btnSendDigest.disabled = ctx.busy || ctx.queueLength === 0;
}

function setBusy(busy) {
  ctx.busy = busy;
  updateButtons();
}

function renderQueue(queue) {
  const count = Array.isArray(queue) ? queue.length : 0;
  ctx.queueLength = count;
  el.queueCount.textContent = `${count} article${count === 1 ? '' : 's'} in queue`;
  updateButtons();
}

// Images the page inlined into queued articles share one budget (the same as
// a single send), so the queue stays small enough to store and to email as a
// digest. Past it, a new article's images keep their original links.
const QUEUE_IMAGE_BUDGET = 20 * 1024 * 1024;
const DATA_SRC_RE = /\ssrc="(data:[^"]*)"/i;
const ORIGINAL_SRC_RE = /\sdata-s2k-src="([^"]*)"/i;

function inlinedImageSize(html) {
  let n = 0;
  for (const m of String(html || '').matchAll(/\ssrc="(data:[^"]*)"/gi)) n += m[1].length;
  return n;
}

function capInlinedImages(html, budget) {
  let total = 0;
  return String(html || '').replace(/<img\b[^>]*>/gi, (tag) => {
    const src = DATA_SRC_RE.exec(tag);
    if (!src) return tag;
    const original = ORIGINAL_SRC_RE.exec(tag);
    if (original && total + src[1].length > budget) return tag.replace(src[0], ` src="${original[1]}"`);
    total += src[1].length;
    return tag;
  });
}

async function loadQueue() {
  const { queue } = await chrome.storage.local.get(['queue']);
  return Array.isArray(queue) ? queue : [];
}

function showSending(text) {
  el.loadingText.textContent = text || 'Sending…';
  showState('loading');
}

/** anyway: optional { label, fn } for a "Send anyway" style button. */
function showError(message, retryFn, anyway) {
  el.errorMessage.textContent = message || 'Something went wrong. Please try again.';
  ctx.retry = retryFn || null;
  ctx.anyway = anyway ? anyway.fn : null;
  el.btnRetry.classList.toggle('hidden', !retryFn);
  el.btnAnyway.textContent = anyway ? anyway.label : '';
  el.btnAnyway.classList.toggle('hidden', !anyway);
  showState('error');
}

function showSent(label, note) {
  el.sentMsg.textContent = label ? `${label}!` : 'Sent to your Kindle!';
  el.sentNote.textContent = note || '';
  el.sentNote.classList.toggle('hidden', !note);
  showState('sent');
}

function backToMain() {
  setBusy(false);
  showState('main');
}

async function markStatusSeen() {
  try {
    const { sendStatus } = await chrome.storage.local.get(['sendStatus']);
    // Never overwrite a send that started since this status was shown.
    if (sendStatus && !sendStatus.seen && sendStatus.state !== 'sending') {
      await chrome.storage.local.set({ sendStatus: { ...sendStatus, seen: true } });
    }
  } catch (_) { /* cosmetic */ }
}

// ─── Talking to the page and the service worker ───────────────────────────────

async function runInTab(tabId, func) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func });
  return res ? res.result : undefined;
}

async function probeTab(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  return runInTab(tabId, () => globalThis.__s2k.probe());
}

async function extractArticle(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/Readability.js', 'content.js'],
    });
    const result = await runInTab(tabId, () => globalThis.__s2k.extract());
    return result || { success: false, error: "Couldn't read this article. Reload the page and try again." };
  } catch (_) {
    return { success: false, error: 'This tab changed or closed. Open the article and try again.' };
  }
}

async function askBackground(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    return res || { ok: false, error: 'No response from the extension. Reload it in chrome://extensions and try again.' };
  } catch (err) {
    return { ok: false, error: "The send was interrupted, so it may not have reached your Kindle. Click Retry to send it again." };
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const { kindleEmail, queue } = await chrome.storage.local.get(['kindleEmail', 'queue']);
  if (!kindleEmail) {
    showState('onboarding');
    el.emailOnboarding.focus();
    return;
  }

  renderQueue(queue);
  showState('main');
  chrome.action.setBadgeText({ text: '' }).catch(() => {});

  const statusPromise = askBackground({ type: 'getStatus' });
  const probePromise = loadArticleInfo();

  const status = await statusPromise;
  if (status && status.state === 'sending') {
    ctx.observingSend = true;
    setBusy(true);
    showSending(status.stage);
  } else if (status && (status.state === 'sent' || status.state === 'error') && !status.seen) {
    el.banner.textContent = status.state === 'sent'
      ? `Last send: ${status.label || 'sent to your Kindle'}.`
      : `Last send failed: ${status.message}`;
    el.banner.className = `banner banner-${status.state}`;
    markStatusSeen();
  }

  await probePromise;
}

async function loadArticleInfo() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) { /* treated as no tab */ }

  if (!tab || tab.id == null) {
    renderNoArticle(CANT_READ_MSG);
    return;
  }
  ctx.tabId = tab.id;

  let info;
  try {
    info = await probeTab(tab.id);
  } catch (_) {
    // chrome:// pages, the Web Store, PDFs and other pages extensions can't read.
    renderNoArticle(CANT_READ_MSG);
    return;
  }

  if (!info) {
    renderNoArticle(CANT_READ_MSG);
    return;
  }

  el.articleTitle.textContent = info.title || '(Untitled)';
  el.articleTitle.title = info.title || '';
  el.articleAuthor.textContent = info.byline || '';
  ctx.hasArticle = true;
  updateButtons();

  // Start the full extraction now so Send and Add to Queue don't wait for it.
  // Its title and author are more complete (the reader view finds bylines the
  // quick look can't), so show them when it finishes.
  const extraction = extractArticle(tab.id);
  ctx.extractPromise = extraction;
  extraction.then((result) => {
    const article = result && result.article;
    if (!article || ctx.extractPromise !== extraction) return;
    if (article.title) {
      el.articleTitle.textContent = article.title;
      el.articleTitle.title = article.title;
    }
    el.articleAuthor.textContent = article.byline || '';
  });
}

function renderNoArticle(message) {
  ctx.hasArticle = false;
  el.articleTitle.textContent = message;
  el.articleTitle.classList.add('muted');
  el.articleAuthor.textContent = '';
  updateButtons();
}

/** Await the prefetched extraction; on failure, set up a fresh one for the retry. */
async function getExtracted() {
  const result = await ctx.extractPromise;
  if (!result || !result.success) {
    ctx.extractPromise = null;
  }
  return result || { success: false };
}

function ensureExtraction() {
  if (!ctx.extractPromise && ctx.tabId != null) ctx.extractPromise = extractArticle(ctx.tabId);
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * A refusal the reader may overrule: a paywall or "not an article" verdict
 * that still came with some article text. Never offered when nothing usable
 * was found.
 */
function anywayOption(extracted, label, fn) {
  const overrulable = extracted && (extracted.code === 'gated' || extracted.code === 'not_article');
  return overrulable && extracted.article && extracted.article.content ? { label, fn } : null;
}

async function sendArticle() {
  if (ctx.busy || !ctx.hasArticle) return;
  setBusy(true);
  el.btnSend.textContent = 'Sending…';
  try {
    ensureExtraction();
    const extracted = await getExtracted();
    if (!extracted.success) {
      showError(extracted.error, sendArticle,
        anywayOption(extracted, 'Send anyway', () => sendExtracted(extracted.article)));
      return;
    }
    await sendExtracted(extracted.article, sendArticle);
  } finally {
    el.btnSend.textContent = 'Send to Kindle';
  }
}

async function sendExtracted(article, retryFn) {
  setBusy(true);
  showSending('Sending…');
  const res = await askBackground({ type: 'send', mode: 'article', article });
  handleSendResult(res, retryFn || (() => sendExtracted(article)));
}

async function sendDigest() {
  if (ctx.busy || ctx.queueLength === 0) return;
  setBusy(true);
  showSending('Building digest…');
  const res = await askBackground({ type: 'send', mode: 'digest' });
  handleSendResult(res, sendDigest);
}

function handleSendResult(res, retryFn) {
  if (res && res.ok) {
    showSent(res.label, res.note);
    markStatusSeen();
    return;
  }
  if (res && res.code === 'busy') {
    ctx.observingSend = true;
    showSending('Another send is in progress…');
    return;
  }
  if (res && res.code === 'no_email') {
    setBusy(false);
    showState('onboarding');
    return;
  }
  showError(res && res.error, retryFn);
  markStatusSeen();
}

async function addToQueue() {
  if (ctx.busy || !ctx.hasArticle) return;
  setBusy(true);
  el.btnAddQueue.textContent = 'Adding…';
  try {
    ensureExtraction();
    const extracted = await getExtracted();
    if (!extracted.success) {
      showError(extracted.error, addToQueue,
        anywayOption(extracted, 'Add anyway', () => queueExtracted(extracted.article)));
      return;
    }
    await saveToQueue(extracted.article);
  } finally {
    el.btnAddQueue.textContent = 'Add to Queue';
    if (!states.error.classList.contains('hidden')) return; // keep busy while the error shows
    setBusy(false);
  }
}

async function queueExtracted(article) {
  setBusy(true);
  try {
    await saveToQueue(article);
  } finally {
    setBusy(false);
  }
}

async function saveToQueue(article) {
  const queue = await loadQueue();
  if (queue.some((a) => a.url === article.url)) {
    flash(el.actionMsg, 'Already in queue');
    return;
  }
  const used = queue.reduce((n, a) => n + inlinedImageSize(a.content), 0);
  const next = queue.concat([{
    title: article.title,
    byline: article.byline,
    date: article.date,
    url: article.url,
    content: capInlinedImages(article.content, Math.max(0, QUEUE_IMAGE_BUDGET - used)),
  }]);
  try {
    await chrome.storage.local.set({ queue: next });
  } catch (err) {
    flash(el.actionMsg, `Couldn't save to your queue: ${err.message}`, 'error', 0);
    return;
  }
  renderQueue(next);
  flash(el.actionMsg, 'Added to queue', 'success');
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

el.btnSend.addEventListener('click', sendArticle);
el.btnAddQueue.addEventListener('click', addToQueue);
el.btnSendDigest.addEventListener('click', sendDigest);

el.btnRetry.addEventListener('click', () => {
  const retry = ctx.retry;
  backToMain();
  if (retry) retry();
});
el.btnAnyway.addEventListener('click', () => {
  const anyway = ctx.anyway;
  backToMain();
  if (anyway) anyway();
});
el.btnDismissError.addEventListener('click', backToMain);
el.btnSentDone.addEventListener('click', backToMain);

states.onboarding.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = el.emailOnboarding.value.trim();
  if (!KINDLE_EMAIL_RE.test(email)) {
    el.errorOnboarding.textContent = 'Enter your Send to Kindle address. It ends in @kindle.com.';
    el.errorOnboarding.classList.remove('hidden');
    return;
  }
  el.errorOnboarding.classList.add('hidden');
  try {
    await chrome.storage.local.set({ kindleEmail: email, onboardingComplete: true });
  } catch (err) {
    el.errorOnboarding.textContent = `Couldn't save: ${err.message}`;
    el.errorOnboarding.classList.remove('hidden');
    return;
  }
  init();
});

el.btnSettings.addEventListener('click', async () => {
  const isOpen = !el.settingsPanel.classList.contains('hidden');
  el.btnSettings.setAttribute('aria-expanded', String(!isOpen));
  if (isOpen) {
    el.settingsPanel.classList.add('hidden');
    return;
  }
  const { kindleEmail } = await chrome.storage.local.get(['kindleEmail']);
  el.emailSettings.value = kindleEmail || '';
  el.settingsMsg.classList.add('hidden');
  el.imagesMsg.classList.add('hidden');
  el.allImages.checked = await chrome.permissions.contains(ALL_SITES).catch(() => false);
  el.settingsPanel.classList.remove('hidden');
  el.emailSettings.focus();
});

// "Include images from any site": the optional <all_urls> host permission lets
// the service worker download article images hosted on other sites (CDNs).
// chrome.permissions.request must run straight from the click, before any await.
el.allImages.addEventListener('change', () => {
  const want = el.allImages.checked;
  const change = want ? chrome.permissions.request(ALL_SITES) : chrome.permissions.remove(ALL_SITES);
  change.then((ok) => {
    el.allImages.checked = want ? !!ok : !ok;
    if (want) {
      flash(el.imagesMsg, ok ? 'Images from any site will be included.' : 'Not turned on. Some images from other sites may be left out.', ok ? 'success' : 'info', 3000);
    }
  }, (err) => {
    el.allImages.checked = !want;
    flash(el.imagesMsg, `Couldn't change this: ${err.message}`, 'error', 0);
  });
});

// On some systems (macOS among them) the popup closes when Chrome shows its
// permission prompt, and the request above never reports back. Chrome's own
// change events keep the box right whenever the popup is open; a reopened
// popup reads the current state when Settings opens.
function syncAllImages() {
  chrome.permissions.contains(ALL_SITES).then((on) => { el.allImages.checked = !!on; }, () => {});
}
if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(syncAllImages);
if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(syncAllImages);

el.settingsPanel.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = el.emailSettings.value.trim();
  if (!KINDLE_EMAIL_RE.test(email)) {
    flash(el.settingsMsg, 'That should end in @kindle.com.', 'error', 0);
    return;
  }
  try {
    await chrome.storage.local.set({ kindleEmail: email });
    flash(el.settingsMsg, 'Saved', 'success', 2000);
  } catch (err) {
    flash(el.settingsMsg, `Couldn't save: ${err.message}`, 'error', 0);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.queue) renderQueue(changes.queue.newValue);

  const status = changes.sendStatus && changes.sendStatus.newValue;
  if (!status) return;
  if (status.state === 'sending') {
    if (!states.loading.classList.contains('hidden')) el.loadingText.textContent = status.stage || 'Sending…';
    return;
  }
  // A send this popup didn't start (or started before it reopened) just finished.
  if (ctx.observingSend) {
    ctx.observingSend = false;
    if (status.state === 'sent') showSent(status.label, status.note);
    else showError(status.message, null);
    markStatusSeen();
  }
});

init().catch((err) => showError(`The popup failed to load: ${err.message}`, () => init()));
