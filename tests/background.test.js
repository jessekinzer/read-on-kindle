'use strict';

// Service worker logic: formatting, image inlining, error messages, and the
// send pipeline with chrome.* and the Gmail API mocked. No real email is sent.

function makeChromeMock(initial = {}) {
  const store = { ...initial };
  return {
    store,
    runtime: { lastError: null, id: 'test', getPlatformInfo: (cb) => cb && cb({}) },
    storage: {
      local: {
        get: jest.fn(async (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; });
          return out;
        }),
        set: jest.fn(async (obj) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); }),
      },
    },
    action: {
      setBadgeText: jest.fn(async () => {}),
      setBadgeBackgroundColor: jest.fn(async () => {}),
    },
    identity: {
      getAuthToken: jest.fn((opts, cb) => cb('token-1')),
      removeCachedAuthToken: jest.fn((opts, cb) => cb()),
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => 'application/json' },
  };
}

const ARTICLE = {
  title: 'A Long Essay — With Dashes',
  byline: 'Jane Writer',
  date: 'March 1, 2026',
  url: 'https://jane.substack.com/p/essay',
  content: '<p>' + 'Body text. '.repeat(50) + '</p>',
};

let bg;
beforeEach(() => {
  jest.resetModules();
  global.chrome = makeChromeMock({ kindleEmail: 'me@kindle.com', queue: [] });
  global.fetch = jest.fn(async () => jsonResponse(200, { id: 'msg-1' }));
  bg = require('../background.js');
});

afterEach(() => {
  delete global.chrome;
  delete global.fetch;
});

describe('formatting', () => {
  test('article HTML escapes the title and keeps the body', () => {
    const html = bg.formatArticleHtml({ ...ARTICLE, title: '<script>x</script>' });
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('Body text.');
    expect(html).toContain('href="https://jane.substack.com/p/essay"');
  });

  test('article HTML drops non-http links', () => {
    const html = bg.formatArticleHtml({ ...ARTICLE, url: 'javascript:alert(1)' });
    expect(html).not.toContain('javascript:');
  });

  test('digest has a table of contents and one section per article', () => {
    const html = bg.formatDigestHtml([ARTICLE, { ...ARTICLE, title: 'Second', url: 'https://x.substack.com/p/2' }]);
    expect(html).toContain('href="#article-1"');
    expect(html).toContain('href="#article-2"');
    expect(html).toContain('2 articles');
  });

  test('filenames are header safe and readable', () => {
    expect(bg.toFilename('A/B: "C" — D')).toBe('AB C - D');
    expect(bg.toFilename('Don’t “Panic” – Café…')).toBe("Don't Panic - Cafe...");
    expect(bg.toFilename('')).toBe('article');
  });
});

describe('inlineImages', () => {
  function imageResponse(type, bytes = [1, 2, 3]) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => type },
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
    };
  }

  test('replaces supported images with data URIs and decodes &amp; in URLs', async () => {
    const fetchFn = jest.fn(async () => imageResponse('image/jpeg'));
    const out = await bg.inlineImages('<p><img alt="a" src="https://substackcdn.com/i.jpg?a=1&amp;b=2"></p>', { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith('https://substackcdn.com/i.jpg?a=1&b=2', expect.any(Object));
    expect(out).toContain('src="data:image/jpeg;base64,AQID"');
  });

  test('keeps the original URL for WebP, HTTP errors, and network failures', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url.includes('webp')) return imageResponse('image/webp');
      if (url.includes('404')) return { ok: false, status: 404, headers: { get: () => '' } };
      throw new TypeError('Failed to fetch');
    });
    const html = '<img src="https://a/webp"><img src="https://a/404"><img src="https://a/down">';
    expect(await bg.inlineImages(html, { fetchFn })).toBe(html);
  });

  test('a hanging image times out instead of blocking the send', async () => {
    const fetchFn = jest.fn((url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const html = '<img src="https://a/slow.jpg">';
    const started = Date.now();
    expect(await bg.inlineImages(html, { fetchFn, timeoutMs: 50 })).toBe(html);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('images the page already inlined count toward the size budget', async () => {
    const fetchFn = jest.fn(async () => imageResponse('image/png', new Array(300).fill(7)));
    const pageInlined = `data:image/png;base64,${'A'.repeat(400)}`;
    const out = await bg.inlineImages(`<img src="${pageInlined}"><img src="https://cdn.example/2.png">`, {
      fetchFn, maxTotalBytes: 500,
    });
    expect(out).toContain('src="https://cdn.example/2.png"');
  });

  test('reports how many images were left as remote links', async () => {
    const fetchFn = jest.fn(async (url) => (url.includes('ok')
      ? imageResponse('image/jpeg')
      : { ok: false, status: 403, headers: { get: () => '' } }));
    const stats = {};
    await bg.inlineImages('<img src="https://a/ok.jpg"><img src="https://b/no.jpg"><img src="https://c/no2.jpg">', { fetchFn, stats });
    expect(stats.remote).toBe(2);
  });

  test('stops inlining once the size budget is used', async () => {
    const fetchFn = jest.fn(async () => imageResponse('image/png', new Array(300).fill(7)));
    const out = await bg.inlineImages('<img src="https://a/1.png"><img src="https://a/2.png">', {
      fetchFn, maxTotalBytes: 500, concurrency: 1,
    });
    expect(out.match(/data:image\/png/g)).toHaveLength(1);
  });
});

describe('capInlinedImages (page-inlined images across a digest)', () => {
  const big = (c) => `data:image/png;base64,${c.repeat(400)}`;

  test('past the budget, later page-inlined images go back to their links; markers are removed', () => {
    const html = `<img src="${big('A')}" data-s2k-src="https://site.example/1.png?a=1&amp;b=2">`
      + `<p>text</p><img alt="x" src="${big('B')}" data-s2k-src="https://site.example/2.png">`;
    const out = bg.capInlinedImages(html, 500);
    expect(out).toContain(`src="${big('A')}"`);
    expect(out).toContain('<img alt="x" src="https://site.example/2.png">');
    expect(out).not.toContain('data-s2k-src');
  });

  test('within the budget nothing changes except the markers', () => {
    const html = `<img src="${big('A')}" data-s2k-src="https://site.example/1.png">`;
    expect(bg.capInlinedImages(html, 10000)).toBe(`<img src="${big('A')}">`);
  });

  test('a digest of two image-heavy queued articles is sent within the budget', async () => {
    const huge = `data:image/png;base64,${'Q'.repeat(12 * 1024 * 1024)}`;
    const item = (n) => ({
      ...ARTICLE, title: `Post ${n}`, url: `https://site.example/${n}`,
      content: `<p>Body ${n}</p><img src="${huge}" data-s2k-src="https://site.example/${n}.png">`,
    });
    global.chrome.store.queue = [item(1), item(2)];
    const res = await bg.handleSend({ type: 'send', mode: 'digest' });
    expect(res.ok).toBe(true);
    const mime = global.fetch.mock.calls.find(([url]) => String(url).includes('googleapis'))[1].body;
    const b64 = mime.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n\r\n--')[0].replace(/\r\n/g, '');
    const html = Buffer.from(b64, 'base64').toString('utf8');
    expect(html.match(/src="data:image\/png/g)).toHaveLength(1);
    expect(html).toContain('src="https://site.example/2.png"');
    expect(html).not.toContain('data-s2k-src');
    expect(mime.length).toBeLessThan(35 * 1024 * 1024);
  });
});

describe('friendlyError', () => {
  test.each([
    [Object.assign(new Error('Failed to fetch'), { code: 'network' }), /internet connection/],
    [Object.assign(new Error('timed out'), { code: 'timeout' }), /too long/],
    [new Error('The user did not approve access.'), /cancelled/],
    [new Error("OAuth2 request failed: Service responded with error: 'bad client id: 123'"), /OAuth client/],
    [Object.assign(new Error('The user turned off browser signin'), { code: 'signin_off' }), /sign in with the Google account/],
    [Object.assign(new Error('not configured'), { code: 'web_auth_unconfigured' }), /isn't set up yet/],
    [Object.assign(new Error('state mismatch'), { code: 'state_mismatch' }), /couldn't be verified/],
    [new Error('OAuth2 not granted or revoked.'), /cancelled/],
    [Object.assign(new Error('Invalid To header'), { status: 400 }), /Kindle address/],
    [Object.assign(new Error('Insufficient Permission'), { status: 403 }), /refused/],
    [Object.assign(new Error('Too many'), { status: 429 }), /rate limiting/],
    [Object.assign(new Error('Backend Error'), { status: 503 }), /temporary problem/],
  ])('%s', (err, expected) => {
    expect(bg.friendlyError(err)).toMatch(expected);
  });
});

describe('handleSend', () => {
  test('sends a single article through the Gmail upload endpoint', async () => {
    const res = await bg.handleSend({ type: 'send', mode: 'article', article: ARTICLE });
    expect(res).toEqual({ ok: true, label: 'Sent to your Kindle' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain('/upload/gmail/v1/users/me/messages/send?uploadType=media');
    expect(init.headers.Authorization).toBe('Bearer token-1');
    expect(init.headers['Content-Type']).toBe('message/rfc822');
    expect(init.body).toContain('To: me@kindle.com');
    expect(init.body).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(chrome.store.sendStatus.state).toBe('sent');
  });

  describe('images from other sites (optional <all_urls> permission)', () => {
    const withImage = { ...ARTICLE, content: ARTICLE.content + '<img src="https://cdn.other.example/a.jpg">' };
    beforeEach(() => {
      // Gmail succeeds; the cross-site image fails as it would without host permission (CORS).
      fetch.mockImplementation(async (url) => (String(url).includes('googleapis')
        ? jsonResponse(200, { id: 'm' })
        : Promise.reject(new TypeError('Failed to fetch'))));
    });

    test('declined: the send still succeeds and the note points to the setting', async () => {
      chrome.permissions = { contains: jest.fn(async () => false) };
      const res = await bg.handleSend({ mode: 'article', article: withImage });
      expect(res.ok).toBe(true);
      expect(res.note).toMatch(/1 image couldn't be included.*Include images from any site/);
      expect(chrome.permissions.contains).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
      expect(chrome.store.sendStatus.note).toBe(res.note);
      const body = fetch.mock.calls.find(([u]) => String(u).includes('googleapis'))[1].body;
      expect(body).toBeTruthy();
    });

    test('granted: no note, even if an image still failed', async () => {
      chrome.permissions = { contains: jest.fn(async () => true) };
      const res = await bg.handleSend({ mode: 'article', article: withImage });
      expect(res).toEqual({ ok: true, label: 'Sent to your Kindle' });
    });

    test('no remote images: no note and no permission check', async () => {
      chrome.permissions = { contains: jest.fn(async () => false) };
      const res = await bg.handleSend({ mode: 'article', article: ARTICLE });
      expect(res.note).toBeUndefined();
      expect(chrome.permissions.contains).not.toHaveBeenCalled();
    });
  });

  test('uses the Kindle address saved now, not one captured earlier', async () => {
    chrome.store.kindleEmail = 'new@kindle.com';
    await bg.handleSend({ mode: 'article', article: ARTICLE });
    expect(fetch.mock.calls[0][1].body).toContain('To: new@kindle.com');
  });

  test('no Kindle address: no send, clear error', async () => {
    delete chrome.store.kindleEmail;
    const res = await bg.handleSend({ mode: 'article', article: ARTICLE });
    expect(res).toMatchObject({ ok: false, code: 'no_email' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('empty extraction: no send, clear error', async () => {
    const res = await bg.handleSend({ mode: 'article', article: { ...ARTICLE, content: '' } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Couldn't find the article text/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a second send while one is running is rejected (no double submit)', async () => {
    let release;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(jsonResponse(200, {})); }));
    const first = bg.handleSend({ mode: 'article', article: ARTICLE });
    await new Promise((r) => setTimeout(r, 10));
    const second = await bg.handleSend({ mode: 'article', article: ARTICLE });
    expect(second).toMatchObject({ ok: false, code: 'busy' });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('expired token: drops it, gets a new one, and retries once', async () => {
    chrome.identity.getAuthToken
      .mockImplementationOnce((o, cb) => cb('stale'))
      .mockImplementationOnce((o, cb) => cb('fresh'));
    fetch
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: 'Invalid Credentials' } }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ok' }));
    const res = await bg.handleSend({ mode: 'article', article: ARTICLE });
    expect(res.ok).toBe(true);
    expect(chrome.identity.removeCachedAuthToken).toHaveBeenCalledWith({ token: 'stale' }, expect.any(Function));
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh');
  });

  test('send permission unticked on the consent screen: token dropped, clear instruction', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(403, { error: { message: 'Request had insufficient authentication scopes.' } }));
    const res = await bg.handleSend({ mode: 'article', article: ARTICLE });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/tick the box/);
    expect(chrome.identity.removeCachedAuthToken).toHaveBeenCalledWith({ token: 'token-1' }, expect.any(Function));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('cancelled sign-in is reported without waiting for slow images', async () => {
    chrome.identity.getAuthToken.mockImplementation((o, cb) => {
      chrome.runtime.lastError = { message: 'The user did not approve access.' };
      cb(undefined);
      chrome.runtime.lastError = null;
    });
    let release;
    fetch.mockImplementation(() => new Promise((resolve) => { release = () => resolve(jsonResponse(404, {})); }));
    const article = { ...ARTICLE, content: ARTICLE.content + '<img src="https://substackcdn.com/slow.png">' };
    const res = await bg.handleSend({ mode: 'article', article });
    // Answered while the image is still downloading.
    expect(res.error).toMatch(/sign-in was cancelled/);
    expect(release).toEqual(expect.any(Function));
    release();
  });

  test('Gmail not signed in / consent cancelled: friendly error and error status', async () => {
    chrome.identity.getAuthToken.mockImplementation((o, cb) => {
      chrome.runtime.lastError = { message: 'The user did not approve access.' };
      cb(undefined);
      chrome.runtime.lastError = null;
    });
    const res = await bg.handleSend({ mode: 'article', article: ARTICLE });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/sign-in was cancelled/);
    expect(chrome.store.sendStatus).toMatchObject({ state: 'error', seen: false });
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
  });

  test('network failure: friendly error, never a hang', async () => {
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const res = await bg.handleSend({ mode: 'article', article: ARTICLE });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/internet connection/);
  });

  describe('digest', () => {
    const queued = [
      { ...ARTICLE, url: 'https://a.substack.com/p/1', title: 'One' },
      { ...ARTICLE, url: 'https://a.substack.com/p/2', title: 'Two' },
    ];

    test('sends all queued articles and clears only what was sent', async () => {
      chrome.store.queue = queued;
      let release;
      fetch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(jsonResponse(200, {})); }));
      const pending = bg.handleSend({ mode: 'digest' });
      await new Promise((r) => setTimeout(r, 10));
      // Something added to the queue while the digest is sending must survive.
      chrome.store.queue = [...queued, { ...ARTICLE, url: 'https://a.substack.com/p/3', title: 'Three' }];
      release();
      const res = await pending;
      expect(res).toEqual({ ok: true, label: 'Digest sent, 2 articles' });
      expect(chrome.store.queue.map((a) => a.title)).toEqual(['Three']);
    });

    test('failed send keeps the queue intact', async () => {
      chrome.store.queue = queued;
      fetch.mockResolvedValueOnce(jsonResponse(500, { error: { message: 'Backend Error' } }));
      const res = await bg.handleSend({ mode: 'digest' });
      expect(res.ok).toBe(false);
      expect(chrome.store.queue).toHaveLength(2);
    });

    test('empty queue: no send', async () => {
      const res = await bg.handleSend({ mode: 'digest' });
      expect(res).toMatchObject({ ok: false, code: 'empty_queue' });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  test('getStatus turns a stale "sending" status into an error after a worker restart', async () => {
    chrome.store.sendStatus = { state: 'sending', at: Date.now() };
    const status = await bg.getStatus();
    expect(status.state).toBe('error');
    expect(status.message).toMatch(/didn't finish/);
  });
});
