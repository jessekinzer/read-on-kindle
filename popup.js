'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

/** Currently extracted article (in memory, not persisted) */
let currentArticle = null;


// ─── DOM refs ─────────────────────────────────────────────────────────────────

const states = {
  onboarding: document.getElementById('state-onboarding'),
  main:       document.getElementById('state-main'),
  inactive:   document.getElementById('state-inactive'),
  loading:    document.getElementById('state-loading'),
  error:      document.getElementById('state-error'),
  sent:       document.getElementById('state-sent'),
};

const el = {
  // Onboarding
  emailOnboarding:  document.getElementById('input-kindle-email-onboarding'),
  btnSaveEmail:     document.getElementById('btn-save-email'),
  errorOnboarding:  document.getElementById('error-onboarding'),

  // Main
  articleTitle:     document.getElementById('article-title'),
  articleAuthor:    document.getElementById('article-author'),
  btnSend:          document.getElementById('btn-send'),
  btnAddQueue:      document.getElementById('btn-add-queue'),
  btnSendDigest:    document.getElementById('btn-send-digest'),
  queueCount:       document.getElementById('queue-count'),
  alreadyQueuedMsg: document.getElementById('already-queued-msg'),

  // Settings
  btnSettings:      document.getElementById('btn-settings'),
  settingsPanel:    document.getElementById('settings-panel'),
  emailSettings:    document.getElementById('input-kindle-email-settings'),
  btnUpdateEmail:   document.getElementById('btn-update-email'),
  settingsSavedMsg: document.getElementById('settings-saved-msg'),

  // Error
  errorMessage:     document.getElementById('error-message'),
  btnRetry:         document.getElementById('btn-retry'),
  btnDismissError:  document.getElementById('btn-dismiss-error'),
};

// ─── State transitions ────────────────────────────────────────────────────────

function showState(name) {
  Object.entries(states).forEach(([key, node]) => {
    node.classList.toggle('hidden', key !== name);
  });
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

// ─── Queue helpers ────────────────────────────────────────────────────────────

async function loadQueue() {
  const data = await storageGet(['queue']);
  return Array.isArray(data.queue) ? data.queue : [];
}

async function saveQueue(queue) {
  await storageSet({ queue });
}

function updateQueueUI(queue) {
  const count = queue.length;
  el.queueCount.textContent = count === 1 ? '1 in queue' : `${count} in queue`;
  el.btnSendDigest.disabled = count === 0;
}

// ─── HTML Formatter (Step 5) ──────────────────────────────────────────────────

function formatArticleHtml(article) {
  const { title = '', byline = '', date = '', url = '', content = '' } = article;
  const meta = [byline, date].filter(Boolean).join(' · ');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escHtml(title)}</title>
</head>
<body style="font-family: Georgia, serif; font-size: 16px; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="font-size: 24px; margin-bottom: 8px;">${escHtml(title)}</h1>
  <p style="font-size: 14px; color: #666; margin-bottom: 16px;">${escHtml(meta)}${meta && url ? ' · ' : ''}${url ? `<a href="${escAttr(url)}">${escHtml(url)}</a>` : ''}</p>
  <hr style="border: none; border-top: 1px solid #ddd; margin-bottom: 20px;">
  ${content}
</body>
</html>`;
}

function formatDigestHtml(articles) {
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  const toc = articles.map((a, i) =>
    `<li><a href="#article-${i + 1}">${escHtml(a.title || 'Untitled')}</a>${a.byline ? ` — ${escHtml(a.byline)}` : ''}</li>`
  ).join('\n');

  const bodies = articles.map((a, i) => {
    const meta = [a.byline, a.date].filter(Boolean).join(' · ');
    return `<div id="article-${i + 1}" style="margin-bottom: 48px;">
  <h2 style="font-size: 22px; margin-bottom: 8px;">${escHtml(a.title || 'Untitled')}</h2>
  <p style="font-size: 14px; color: #666; margin-bottom: 16px;">${escHtml(meta)}${meta && a.url ? ' · ' : ''}${a.url ? `<a href="${escAttr(a.url)}">${escHtml(a.url)}</a>` : ''}</p>
  <hr style="border: none; border-top: 1px solid #ddd; margin-bottom: 20px;">
  ${a.content || ''}
</div>`;
  }).join('\n<hr style="border: none; border-top: 2px solid #ccc; margin: 32px 0;">\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Substack Digest — ${escHtml(today)}</title>
</head>
<body style="font-family: Georgia, serif; font-size: 16px; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="font-size: 26px; margin-bottom: 6px;">Substack Digest</h1>
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

// ─── Escape helpers ───────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

// ─── Slug helper ──────────────────────────────────────────────────────────────

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'article';
}

// ─── Sending logic (Step 6) ───────────────────────────────────────────────────

async function sendToKindle(htmlString, subject, kindleEmail) {
  const filename = slugify(subject) + '.html';
  showState('loading');
  document.querySelector('.loading-text').textContent = 'Sending…';

  try {
    const token = await getAuthToken();
    await sendEmail(token, kindleEmail, subject, htmlString, filename);
    showState('sent');
    return true;
  } catch (err) {
    showError(err.message || 'Failed to send. Please try again.', null);
    return false;
  } finally {
    document.querySelector('.loading-text').textContent = 'Loading article…';
  }
}

// ─── Main flow ────────────────────────────────────────────────────────────────

async function init() {
  showState('loading');

  // 1. Check for saved Kindle email
  const data = await storageGet(['kindleEmail', 'queue']);
  const kindleEmail = data.kindleEmail;

  if (!kindleEmail) {
    showState('onboarding');
    return;
  }

  // 2. Check we're on a Substack tab
  let tab;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = activeTab;
  } catch (_) {
    showState('inactive');
    return;
  }

  if (!tab || !tab.url || !tab.url.match(/^https?:\/\/[^/]*\.substack\.com\//)) {
    showState('inactive');
    return;
  }

  // 3. Extract article from content script
  extractAndDisplay(tab, kindleEmail, data.queue);
}

function extractAndDisplay(tab, kindleEmail, rawQueue) {
  showState('loading');

  chrome.tabs.sendMessage(tab.id, { type: 'extractArticle' }, (response) => {
    if (chrome.runtime.lastError) {
      showError(
        'Could not reach the content script. Try reloading the page.',
        () => extractAndDisplay(tab, kindleEmail, rawQueue)
      );
      return;
    }

    if (!response || !response.success) {
      showError(
        response?.error || 'Could not extract article content.',
        () => extractAndDisplay(tab, kindleEmail, rawQueue)
      );
      return;
    }

    currentArticle = response.article;

    // Populate article info
    el.articleTitle.textContent = currentArticle.title || '(Untitled)';
    el.articleAuthor.textContent = currentArticle.byline || '';

    // Update queue UI
    const queue = Array.isArray(rawQueue) ? rawQueue : [];
    updateQueueUI(queue);

    // Show main state
    showState('main');

    // Wire up action buttons now that we have article + email
    wireMainButtons(tab, kindleEmail);
  });
}

function wireMainButtons(tab, kindleEmail) {
  // Only attach listeners once (replace element to clear old ones)
  const btnSend      = replaceNode(el.btnSend);
  const btnAddQueue  = replaceNode(el.btnAddQueue);
  const btnSendDigest = replaceNode(el.btnSendDigest);
  el.btnSend      = btnSend;
  el.btnAddQueue  = btnAddQueue;
  el.btnSendDigest = btnSendDigest;

  btnSend.addEventListener('click', async () => {
    if (!currentArticle || !kindleEmail) return;
    const html = formatArticleHtml(currentArticle);
    await sendToKindle(html, currentArticle.title || 'Substack Article', kindleEmail);
  });

  btnAddQueue.addEventListener('click', async () => {
    if (!currentArticle) return;
    const queue = await loadQueue();
    const alreadyIn = queue.some(a => a.url === currentArticle.url);
    if (alreadyIn) {
      showAlreadyQueued();
      return;
    }
    queue.push({
      title:   currentArticle.title,
      byline:  currentArticle.byline,
      date:    currentArticle.date,
      url:     currentArticle.url,
      content: currentArticle.content,
    });
    await saveQueue(queue);
    updateQueueUI(queue);
  });

  btnSendDigest.addEventListener('click', async () => {
    const queue = await loadQueue();
    if (queue.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const html = formatDigestHtml(queue);
    const sent = await sendToKindle(html, `Substack Digest — ${today}`, kindleEmail);
    if (sent) await saveQueue([]);
  });
}

function showAlreadyQueued() {
  el.alreadyQueuedMsg.classList.remove('hidden');
  setTimeout(() => el.alreadyQueuedMsg.classList.add('hidden'), 2500);
}

function showError(message, retryFn) {
  el.errorMessage.textContent = message;
  showState('error');

  const btnRetry = replaceNode(el.btnRetry);
  el.btnRetry = btnRetry;
  const btnDismiss = replaceNode(el.btnDismissError);
  el.btnDismissError = btnDismiss;

  btnRetry.addEventListener('click', () => {
    if (retryFn) retryFn();
  });
  btnDismiss.addEventListener('click', () => {
    showState('inactive');
  });
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

el.btnSaveEmail.addEventListener('click', async () => {
  const email = el.emailOnboarding.value.trim();
  if (!isValidEmail(email)) {
    el.errorOnboarding.textContent = 'Please enter a valid email address.';
    el.errorOnboarding.classList.remove('hidden');
    return;
  }
  el.errorOnboarding.classList.add('hidden');
  await storageSet({ kindleEmail: email });
  // Re-run init now that email is saved
  init();
});

// ─── Settings ─────────────────────────────────────────────────────────────────

el.btnSettings.addEventListener('click', async () => {
  const isOpen = !el.settingsPanel.classList.contains('hidden');
  if (isOpen) {
    el.settingsPanel.classList.add('hidden');
    return;
  }
  // Pre-fill current email
  const { kindleEmail } = await storageGet(['kindleEmail']);
  el.emailSettings.value = kindleEmail || '';
  el.settingsSavedMsg.classList.add('hidden');
  el.settingsPanel.classList.remove('hidden');
});

el.btnUpdateEmail.addEventListener('click', async () => {
  const email = el.emailSettings.value.trim();
  if (!isValidEmail(email)) {
    el.emailSettings.style.borderColor = '#d93025';
    return;
  }
  el.emailSettings.style.borderColor = '';
  await storageSet({ kindleEmail: email });
  el.settingsSavedMsg.classList.remove('hidden');
  setTimeout(() => el.settingsSavedMsg.classList.add('hidden'), 2000);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

/** Replace a DOM node with a clone (removes all old event listeners) */
function replaceNode(node) {
  const clone = node.cloneNode(true);
  node.parentNode.replaceChild(clone, node);
  return clone;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
