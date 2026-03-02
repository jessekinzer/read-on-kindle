'use strict';

function isSubstackPage() {
  // Meta generator tag (most reliable signal)
  const generator = document.querySelector('meta[name="generator"]');
  if (generator && generator.content.toLowerCase().includes('substack')) return true;

  // Scripts or links loading from Substack CDN
  const selectors = 'script[src*="substack"], link[href*="substack"], img[src*="substackcdn"]';
  if (document.querySelector(selectors)) return true;

  // Substack-specific post body class
  if (document.querySelector('.substack-post-content, .available-content')) return true;

  return false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'extractArticle') return false;

  if (!isSubstackPage()) {
    sendResponse({ success: false, notSubstack: true });
    return true;
  }

  try {
    const clone = document.cloneNode(true);
    const reader = new Readability(clone);
    const article = reader.parse();

    if (!article) {
      sendResponse({ success: false, error: 'Readability could not parse this page.' });
      return true;
    }

    // Try to extract publish date from a <time> element
    let date = null;
    const timeEl = document.querySelector('time[datetime]');
    if (timeEl) {
      const dt = timeEl.getAttribute('datetime');
      if (dt) {
        try {
          date = new Date(dt).toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric'
          });
        } catch (_) {
          date = dt;
        }
      }
    }
    if (!date) {
      const timeElText = document.querySelector('time');
      if (timeElText && timeElText.textContent.trim()) {
        date = timeElText.textContent.trim();
      }
    }

    // Prefer og:title — Substack sets it directly from the article title,
    // whereas Readability can pick up teaser/preview titles from related articles.
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();

    sendResponse({
      success: true,
      article: {
        title: ogTitle || article.title || document.title || '',
        byline: article.byline || '',
        content: article.content || '',
        url: window.location.href,
        date
      }
    });
  } catch (err) {
    sendResponse({ success: false, error: err.message || 'Extraction failed.' });
  }

  return true; // keep channel open for async sendResponse
});
