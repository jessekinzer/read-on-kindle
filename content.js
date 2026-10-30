'use strict';

// Injected on demand by the popup (chrome.scripting.executeScript), never on page load.
// Exposes two functions on globalThis.__s2k:
//   probe()   - cheap look, used to show title/author instantly
//   extract() - full Readability extraction, gate check, and same-origin image
//               inlining (needs lib/Readability.js injected first). Async.
// Safe to inject more than once: it only reassigns globalThis.__s2k.

(function () {
  const MIN_USABLE_TEXT = 120; // below this there is nothing worth sending (a menu and a date, say)
  const MIN_TEXT_LENGTH = 200; // below this the page is probably not an article
  const NOT_READABLE_MSG =
    "Couldn't find the article text on this page. Make sure the whole article is showing, then try again.";
  const NOT_ARTICLE_MSG =
    "This page doesn't look like a single article. It may be a home page or a list of links. "
    + 'You can still send what was found.';
  const GATED_MSG =
    'This article is behind a paywall or sign-in, so only part of it is on the page. '
    + 'If you have access, sign in, reload the page, and try again, or send just the part that is showing.';

  // ─── Page metadata ─────────────────────────────────────────────────────────

  function meta(selector) {
    const node = document.querySelector(selector);
    const value = node && node.getAttribute('content');
    return value ? value.trim() : '';
  }

  const ARTICLE_TYPES = new Set([
    'Article', 'NewsArticle', 'AnalysisNewsArticle', 'OpinionNewsArticle', 'ReportageNewsArticle',
    'ReviewNewsArticle', 'BackgroundNewsArticle', 'AskPublicNewsArticle', 'SatiricalArticle',
    'BlogPosting', 'LiveBlogPosting', 'SocialMediaPosting', 'TechArticle', 'APIReference',
    'ScholarlyArticle', 'MedicalScholarlyArticle', 'Report', 'Review', 'HowTo', 'Recipe',
  ]);

  let ldCache = null;
  /** Top-level JSON-LD objects (including @graph members). Nested items such as
   *  a homepage's ItemList of NewsArticles are deliberately not included. */
  function ldObjects() {
    if (ldCache) return ldCache;
    const out = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      let data;
      try { data = JSON.parse(s.textContent); } catch (_) { return; }
      (Array.isArray(data) ? data : [data]).forEach((obj) => {
        if (!obj || typeof obj !== 'object') return;
        out.push(obj);
        if (Array.isArray(obj['@graph'])) obj['@graph'].forEach((g) => g && typeof g === 'object' && out.push(g));
      });
    });
    ldCache = out;
    return out;
  }

  function typesOf(obj) {
    const t = obj['@type'];
    return (Array.isArray(t) ? t : [t]).filter((x) => typeof x === 'string');
  }

  function articleLd() {
    return ldObjects().find((o) => typesOf(o).some((t) => ARTICLE_TYPES.has(t))) || null;
  }

  /** Names from a schema.org author or publisher value (string, object, list, or
   *  an {"@id"} reference to another object on the page, as Yoast and HubSpot write). */
  function ldNames(value) {
    return [].concat(value || []).map((v) => {
      if (typeof v === 'string') return v;
      if (!v || typeof v !== 'object') return '';
      if (typeof v.name === 'string') return v.name;
      const ref = v['@id'] && ldObjects().find((o) => o['@id'] === v['@id'] && typeof o.name === 'string');
      return ref ? ref.name : '';
    }).filter(Boolean);
  }

  const notUrl = (s) => (s && !/^https?:\/\//i.test(s) ? s : '');
  const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const nameKey = (s) => String(s || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');

  function isSubstackPage() {
    if (/(^|\.)substack\.com$/i.test(location.hostname)) return true;
    if (meta('meta[name="generator"]').toLowerCase().includes('substack')) return true;
    if (document.querySelector('script[src*="substack"], link[href*="substack"], img[src*="substackcdn"]')) return true;
    return !!document.querySelector('.substack-post-content, .available-content');
  }

  // Query parameters that only track where a click came from. Everything else
  // in a query string can identify the article (WordPress "/?p=123",
  // "story.php?id=5"), so it is kept.
  const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|mkt_tok|ref|ref_src|ref_url|r|triedRedirect|source|src|smid|cmpid|share|s_cid|sh|si|ocid|guccounter)$/i;

  function withoutTracking(url) {
    Array.from(url.searchParams.keys()).forEach((key) => {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    });
    url.hash = '';
    return url;
  }

  /** Share of the extracted article's text that is link text. */
  function contentLinkDensity(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const total = doc.body.textContent.length;
    if (!total) return 1;
    let links = 0;
    doc.querySelectorAll('a').forEach((a) => { links += a.textContent.length; });
    return links / total;
  }

  /** The article's address, used as its identity in the queue: the canonical
   *  link if there is one, minus tracking parameters. */
  function articleUrl() {
    const canonical = document.querySelector('link[rel="canonical"]');
    const href = canonical && canonical.href;
    return withoutTracking(new URL(href || location.href, location.href)).href;
  }

  // Platforms that put their own name where the author's belongs (substack.com's
  // reader app sets <meta name="author" content="Substack"> on every post).
  const PLATFORM_NAMES = new Set([
    'substack', 'medium', 'wordpress', 'wordpresscom', 'ghost', 'webflow', 'framer', 'hubspot', 'blogger',
    'tumblr', 'wix', 'squarespace', 'beehiiv', 'buttondown', 'linkedin', 'x', 'twitter', 'facebook',
    'notion', 'mirror', 'hashnode', 'devcommunity', 'kit', 'convertkit', 'patreon', 'admin', 'administrator',
  ].map(nameKey));

  /** Names of the site or publisher, which are not authors. */
  function publisherNames() {
    const names = [meta('meta[property="og:site_name"]'), meta('meta[name="application-name"]')];
    for (const obj of ldObjects()) {
      names.push(...ldNames(obj.publisher));
      if (typesOf(obj).some((t) => /^(WebSite|Organization|NewsMediaOrganization|Corporation)$/.test(t))) {
        names.push(...ldNames(obj));
      }
    }
    return names.map(tidy).filter(Boolean);
  }

  function isPlatform(name) {
    return PLATFORM_NAMES.has(nameKey(name));
  }

  /** The publication's own name (never the platform's), shown when no author is given. */
  function publicationName() {
    return publisherNames().find((n) => !isPlatform(n) && n.length <= 80) || '';
  }

  const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s/i;

  /**
   * A cleaned-up author name, or '' when the value is a link, a date, an
   * unfilled template placeholder, the platform, or the publisher.
   */
  function authorName(raw, publishers) {
    const name = tidy(notUrl(tidy(raw))).replace(/^(written\s+)?by:?\s+/i, '');
    if (!name || name.length > 100 || /^about\b/i.test(name) || /@|https?:|[{}<>]/i.test(name)) return '';
    if (/\d/.test(name) && (MONTH.test(`${name} `) || /\b(19|20)\d\d\b/.test(name))) return '';
    const key = nameKey(name);
    if (!key || isPlatform(name) || publishers.some((p) => nameKey(p) === key)) return '';
    return name;
  }

  /** Author names written on the page itself (Substack's byline, rel=author, microdata). */
  function domAuthors() {
    const out = [];
    document.querySelectorAll('.byline-wrapper a[href*="/@"], a[rel~="author"], [itemprop="author"] [itemprop="name"], [itemprop="author"]')
      .forEach((n) => {
        const text = tidy(n.textContent);
        const label = n.querySelector && n.querySelector('[title]');
        out.push(text || (label ? label.getAttribute('title') : ''));
      });
    return out.filter(Boolean);
  }

  /** The article's author: structured data first, then meta tags, then the page's byline. */
  function pageAuthor() {
    const publishers = publisherNames();
    const ld = articleLd();
    const ldAuthors = (ld ? ldNames(ld.author) : []).map((n) => authorName(n, publishers)).filter(Boolean);
    if (ldAuthors.length) return Array.from(new Set(ldAuthors)).slice(0, 3).join(', ');
    const candidates = [meta('meta[name="author"]'), meta('meta[property="article:author"]'), ...domAuthors()];
    for (const c of candidates) {
      const name = authorName(c, publishers);
      if (name) return name;
    }
    return '';
  }

  /**
   * The headline. og:title is preferred (Readability can pick up teaser titles
   * from related-post cards), minus a trailing " - Site name" when the page's
   * own heading shows where the headline ends.
   */
  function pageTitle() {
    const ld = articleLd();
    const title = tidy(meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]')
      || (ld && typeof ld.headline === 'string' ? ld.headline : '') || document.title || '');
    const lower = title.toLowerCase();
    for (const h1 of Array.from(document.querySelectorAll('h1')).slice(0, 3)) {
      const heading = tidy(h1.textContent);
      const rest = lower.slice(heading.length);
      if (heading.length >= 3 && lower.startsWith(heading.toLowerCase()) && /^\s*[-|–—·:•]\s/.test(rest)) return heading;
    }
    // "Headline - The GTM with Clay Blog": drop a last segment naming the site.
    const m = title.match(/^(.+)\s+[-|–—·•]\s+([^-|–—·•]+)$/);
    if (m && publisherNames().some((site) => nameKey(site).length >= 3 && nameKey(m[2]).includes(nameKey(site)))) {
      return m[1];
    }
    return title;
  }

  function formatDate(raw) {
    const d = new Date(raw);
    return isNaN(d.getTime())
      ? raw
      : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function pageDate() {
    const ld = articleLd();
    const raw = meta('meta[property="article:published_time"]')
      || (ld && typeof ld.datePublished === 'string' ? ld.datePublished : '')
      || ((document.querySelector('time[datetime]') || { getAttribute: () => '' }).getAttribute('datetime'));
    if (raw) return formatDate(raw);
    const anyTime = document.querySelector('time');
    return (anyTime && anyTime.textContent.trim()) || '';
  }

  // ─── Gate (paywall / sign-in wall) detection ───────────────────────────────

  const isFalse = (v) => v === false || (typeof v === 'string' && v.trim().toLowerCase() === 'false');

  function visible(el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    }
    return el.getClientRects().length > 0;
  }

  // Overlays and boxes that publishers and paywall vendors put in front of, or
  // in place of, the rest of an article: Piano/TinyPass, Poool, Zephr,
  // LaterPay, and generic paywall/regwall naming.
  const GATE_UI_SELECTOR = [
    '.tp-modal', '.tp-backdrop', '.tp-container-inner', '[class*="piano-paywall"]', '[id*="piano-paywall"]',
    '#poool-widget', '[id^="poool"]', '[class*="poool"]', 'poool-widget',
    '[class*="zephr" i]', '[id*="zephr" i]',
    '[class*="laterpay" i]', '[id*="laterpay" i]', '.lp_paywall',
    '[class*="paywall" i]', '[id*="paywall" i]', '[data-testid*="paywall" i]',
    '[class*="regwall" i]', '[id*="regwall" i]', '[class*="registration-wall" i]',
    '[class*="meter-wall" i]', '[class*="subscriber-wall" i]',
  ].join(', ');

  // Wording of "the rest is locked" calls to action (see gateMessage).
  const GATE_PHRASES = [
    /(subscribe|sign in|log in|register|sign up|create (a )?(free )?account|become a (paid )?member|start (your )?(free )?trial|join now)\b[^.\n]{0,60}\b(to|and) (continue|keep|finish) reading/i,
    /\b(continue|keep) reading (this|the) (article|story|post)[^.\n]{0,40}\b(subscri|sign in|log in|member|register)/i,
    /\b(you('|’)ve|you have) (reached|hit|used) (your|all (of )?your)[^.\n]{0,30}\b(free )?(article|articles|story|stories|gift articles)\b/i,
    /\bthis (article|story|post|content) is (only available|available only|exclusive|reserved) (to|for) (paid |paying |premium )?(subscribers|members)/i,
    /\bthis (article|story|post|content) is available (only|exclusively) to [^.\n]{0,40}\b(subscribers|members)\b/i,
    /\b(the author|this author) made this story available to [^.\n]{0,30}members only/i,
    // "This post is for paid members only" (Ghost), "...for subscribers only".
    /\b(article|story|post|content|piece)\b[^.\n]{0,20}\bfor (paid |paying |premium )?(subscribers|members) only\b/i,
    /\bthis post is for paid subscribers\b/i,
    /\b(subscribe|sign up|sign in|log in|register|become a (paid )?member)\b[^.\n]{0,40}\b(to|and) (read|access|unlock) (the|this) (full|whole|entire|rest of the) (article|story|post)\b/i,
    /\bsign up for free access to this (article|story|post)\b/i,
  ];

  // Reader comment sections. A commenter writing "I had to subscribe to keep
  // reading" is not a paywall, and neither is "subscribe to comment".
  const COMMENT_SELECTOR = '[id*="comment" i], [class*="comment" i], [id*="disqus" i], [class*="replies" i]';

  function commentAreas() {
    return Array.from(document.querySelectorAll(COMMENT_SELECTOR)).filter((el) =>
      !/^(HTML|BODY|MAIN|ARTICLE)$/.test(el.tagName) && !el.querySelector('h1, main, article'));
  }

  const squash = (s) => s.replace(/\s+/g, ' ').toLowerCase();

  /**
   * Is a "subscribe to keep reading" style message on screen? Counted when the
   * message is outside the extracted article, or when it stands on its own (a
   * heading or short block that is mostly the message), because the reader
   * view often takes in a paywall box that sits inside the article's box. A
   * sentence in the article that merely talks about paywalls does not count,
   * nor does anything in reader comments.
   */
  function gateMessage(text) {
    if (!document.body) return false;
    const onScreen = document.body.innerText;
    if (!GATE_PHRASES.some((re) => re.test(onScreen))) return false;

    const areas = commentAreas();
    const inComments = squash(areas.map((el) => el.innerText).join('\n'));
    for (const re of GATE_PHRASES) {
      for (const m of onScreen.matchAll(new RegExp(re.source, 'gi'))) {
        const phrase = squash(m[0]);
        if (!text.includes(phrase) && !inComments.includes(phrase)) return true;
      }
    }

    const blocks = document.body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div, li, section, aside, header, footer');
    for (const el of blocks) {
      const raw = el.textContent;
      if (raw.length > 300 || raw.length < 15) continue;
      const own = squash(raw).trim();
      const standalone = GATE_PHRASES.some((re) => {
        const m = own.match(re);
        return m && m[0].length >= own.length * 0.6;
      });
      if (standalone && visible(el) && !el.closest('blockquote, q, figcaption')
          && !areas.some((a) => a.contains(el))) {
        return true;
      }
    }
    return false;
  }

  /** Declared paid parts (schema.org isAccessibleForFree, JSON-LD or microdata). */
  function paidMarkup() {
    let paid = false;
    const selectors = [];
    for (const obj of ldObjects()) {
      if (!typesOf(obj).some((t) => ARTICLE_TYPES.has(t) || t === 'WebPage' || t === 'CreativeWork')) continue;
      if (isFalse(obj.isAccessibleForFree)) paid = true;
      const parts = Array.isArray(obj.hasPart) ? obj.hasPart : obj.hasPart ? [obj.hasPart] : [];
      parts.forEach((p) => {
        if (p && isFalse(p.isAccessibleForFree)) {
          paid = true;
          [].concat(p.cssSelector).forEach((sel) => { if (typeof sel === 'string' && sel.trim()) selectors.push(sel); });
        }
      });
    }
    document.querySelectorAll('[itemprop="isAccessibleForFree"]').forEach((n) => {
      if (isFalse(n.getAttribute('content') || n.textContent)) paid = true;
    });
    return { paid, selectors };
  }

  function visibleTextOf(selector) {
    let total = 0;
    try {
      document.querySelectorAll(selector).forEach((n) => { if (visible(n)) total += n.innerText.trim().length; });
    } catch (_) { /* invalid selector from the page's markup */ }
    return total;
  }

  function gateBoxVisible() {
    try {
      return Array.from(document.querySelectorAll(GATE_UI_SELECTOR)).some((el) => {
        if (!visible(el)) return false;
        // "Subscribe to comment" boxes gate the comments, not the article.
        if (el.closest('[id*="comment" i], [class*="comment" i]')) return false;
        const len = el.innerText.trim().length;
        return len >= 30 && len <= 1500; // a box or overlay, not a wrapper around the article
      });
    } catch (_) {
      return false; // selector unsupported
    }
  }

  /**
   * Decide whether the page shows only part of a gated article. Returns the
   * list of reasons (empty when the article looks complete). Rules, any one of
   * which refuses the send:
   *   1. Substack's paywall block on a Substack page.
   *   2. The page's own word count or article body says the article is at
   *      least twice as long as what is on screen.
   *   3. A "subscribe / sign in to keep reading" style message is on screen
   *      (see gateMessage).
   *   4. Not on Substack: schema.org marks the article as not free, AND the
   *      paid part is not on the page (or, when the page does not say which
   *      part is paid, a paywall box is visible or the text is short).
   *      Subscribers who see the full text still get marked-paid pages, so
   *      markup alone is not enough. Substack marks every paid post this way,
   *      for paying subscribers too, and rule 1 already covers Substack.
   */
  function gateReasons(articleText) {
    const reasons = [];
    const text = squash(articleText);
    const substack = isSubstackPage();

    if (substack && document.querySelector('[data-testid="paywall"], [data-component-name="Paywall"], .paywall')) {
      reasons.push('substack-paywall');
    }

    const ld = articleLd();
    if (ld) {
      const declaredWords = parseInt(ld.wordCount, 10);
      const words = text.split(' ').filter(Boolean).length;
      // Chinese, Japanese and Thai put no spaces between words, so counting
      // spaces says nothing about their length: skip the word-count check.
      const spaced = words >= text.length / 20;
      if (spaced && declaredWords >= 150 && words < declaredWords * 0.5) reasons.push('word-count');
      const body = typeof ld.articleBody === 'string' ? squash(ld.articleBody.replace(/<[^>]*>/g, ' ')) : '';
      if (body.length >= 1000 && text.length < body.length * 0.5) reasons.push('article-body');
    }

    if (gateMessage(text)) reasons.push('gate-message');

    const { paid, selectors } = substack ? { paid: false, selectors: [] } : paidMarkup();
    if (paid) {
      if (selectors.length) {
        // The page says which part is paid: refuse only when it is not there.
        if (visibleTextOf(selectors.join(', ')) < 1000) reasons.push('paid-markup+missing-text');
      } else if (gateBoxVisible()) {
        reasons.push('paid-markup+gate-box');
      } else if (articleText.length < 3000) {
        reasons.push('paid-markup+missing-text');
      }
    }

    return reasons;
  }

  // ─── Content cleanup and same-origin images ────────────────────────────────

  const KINDLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp'];
  const IMAGE_BUDGET = 20 * 1024 * 1024; // data URI characters, shared with the service worker
  const IMAGE_TIMEOUT_MS = 10000;

  function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /** Kindle reads JPEG, PNG, GIF and BMP. Anything else (WebP, AVIF) is re-encoded as JPEG. */
  async function kindleDataUri(blob) {
    const type = (blob.type || '').toLowerCase();
    if (KINDLE_IMAGE_TYPES.includes(type)) return blobToDataUri(blob);
    if (!type.startsWith('image/') || type.includes('svg')) return null;
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx2d = canvas.getContext('2d');
    ctx2d.fillStyle = '#fff'; // JPEG has no transparency
    ctx2d.fillRect(0, 0, bitmap.width, bitmap.height);
    ctx2d.drawImage(bitmap, 0, 0);
    bitmap.close();
    return blobToDataUri(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
  }

  async function fetchSameOrigin(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, credentials: 'same-origin' });
      if (!res.ok) return null;
      return await kindleDataUri(await res.blob());
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Images on the page's own site are downloaded here, inside the page, because
   * the extension only has access to the page's site through activeTab, which
   * the service worker cannot use. Images on other sites are left for the
   * service worker.
   */
  async function inlineSameOriginImages(container) {
    const imgs = Array.from(container.querySelectorAll('img')).filter((img) => {
      try { return new URL(img.getAttribute('src')).origin === location.origin; } catch (_) { return false; }
    });
    let total = 0;
    let next = 0;
    const cache = new Map(); // the same picture is often used more than once
    async function worker() {
      while (next < imgs.length && total < IMAGE_BUDGET) {
        const img = imgs[next++];
        const src = img.getAttribute('src');
        if (!cache.has(src)) cache.set(src, fetchSameOrigin(src));
        const dataUri = await cache.get(src);
        if (dataUri && total + dataUri.length <= IMAGE_BUDGET) {
          total += dataUri.length;
          img.setAttribute('src', dataUri);
          // Keeps the link, so the queue and the digest can fall back to it
          // when many articles together would be too large to email.
          img.setAttribute('data-s2k-src', src);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, imgs.length) }, worker));
  }

  /**
   * Make the extracted HTML self-contained and Kindle-friendly: drop <picture>
   * sources and srcset (Kindle can't use them and they point at remote, often
   * WebP, files), drop inline SVG icons, buttons, scripts and event handlers,
   * resolve relative image URLs, and inline same-origin images.
   */
  async function buildContent(html) {
    // Parse into an inert document: nothing loads or runs while we clean it.
    const inert = document.implementation.createHTMLDocument('');
    const container = inert.createElement('div');
    container.innerHTML = html;
    container.querySelectorAll('source, svg, button, script, style, iframe, form').forEach((n) => n.remove());
    container.querySelectorAll('*').forEach((node) => {
      Array.from(node.attributes).forEach((attr) => {
        if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      });
    });
    container.querySelectorAll('img').forEach((img) => {
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.removeAttribute('loading');
      const src = img.getAttribute('src');
      if (src && !/^(https?:|data:)/i.test(src)) {
        try { img.setAttribute('src', new URL(src, location.href).href); } catch (_) { /* keep as is */ }
      }
    });
    await inlineSameOriginImages(container);
    return container.innerHTML;
  }

  // ─── Entry points ──────────────────────────────────────────────────────────

  /** Quick look for the popup: title and author, shown before extraction finishes. */
  function probe() {
    ldCache = null;
    return {
      title: pageTitle(),
      byline: pageAuthor() || publicationName(),
      url: articleUrl(),
    };
  }

  /**
   * Full extraction. Detection is permissive: page signals (og:type, schema.org,
   * URL shape) never refuse a page. The result is one of:
   *   success        the article
   *   code 'empty'   nothing usable was found (no article attached)
   *   code 'gated'   paywall signs; the partial article is attached for "Send anyway"
   *   code 'not_article'  very little text, or mostly links (a home page or
   *                  list); what was found is attached for "Send anyway"
   */
  async function extract() {
    ldCache = null;
    if (typeof Readability !== 'function') {
      return { success: false, code: 'no_readability', error: 'The article reader did not load. Reload the page and try again.' };
    }

    try {
      const parsed = new Readability(document.cloneNode(true)).parse();
      const text = parsed && parsed.textContent ? parsed.textContent.trim() : '';
      if (!parsed || !parsed.content || text.length < MIN_USABLE_TEXT) {
        return { success: false, code: 'empty', error: NOT_READABLE_MSG };
      }

      const publishers = publisherNames();
      const article = {
        title: pageTitle() || tidy(parsed.title),
        byline: pageAuthor() || authorName(parsed.byline, publishers) || publicationName(),
        date: pageDate(),
        url: articleUrl(),
        content: await buildContent(parsed.content),
      };

      const reasons = gateReasons(text);
      if (reasons.length) return { success: false, code: 'gated', reasons, error: GATED_MSG, article };
      // Very little text, or what Readability found is mostly links: a home page or list.
      if (text.length < MIN_TEXT_LENGTH || contentLinkDensity(parsed.content) > 0.5) {
        return { success: false, code: 'not_article', error: NOT_ARTICLE_MSG, article };
      }
      return { success: true, article };
    } catch (err) {
      return { success: false, code: 'error', error: (err && err.message) || NOT_READABLE_MSG };
    }
  }

  globalThis.__s2k = { probe, extract };
})();
