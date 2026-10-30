'use strict';

// Gmail sign-in: Google Chrome's account sign-in first, then Google's web
// sign-in (launchWebAuthFlow) in browsers without a Chrome account (Comet,
// Brave, Edge, Arc). chrome.identity is mocked; nothing reaches Google.

const CLIENT_ID = 'test-web-client.apps.googleusercontent.com';
const REDIRECT = 'https://abcdefghabcdefghabcdefghabcdefgh.chromiumapp.org/';

function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

/** A launchWebAuthFlow answer that echoes state and nonce, like Google does. */
const grant = ({ token = 'web-1', email = 'reader@gmail.com', expiresIn = 3600, scope } = {}) => (p) =>
  `${REDIRECT}#access_token=${token}&token_type=Bearer&expires_in=${expiresIn}&state=${p.get('state')}`
  + `&scope=${encodeURIComponent(scope || `openid email ${'https://www.googleapis.com/auth/gmail.send'}`)}`
  + `&id_token=${jwt({ nonce: p.get('nonce'), email })}`;

function makeChrome({ chromeResult = { token: 'chrome-token' }, flows = [] } = {}) {
  const areas = { local: {}, session: {} };
  const area = (name) => ({
    get: jest.fn(async (keys) => {
      const out = {};
      [].concat(keys).forEach((k) => { if (k in areas[name]) out[k] = areas[name][k]; });
      return out;
    }),
    set: jest.fn(async (obj) => { Object.assign(areas[name], JSON.parse(JSON.stringify(obj))); }),
    remove: jest.fn(async (k) => { [].concat(k).forEach((key) => delete areas[name][key]); }),
  });
  const chromeMock = {
    areas,
    runtime: { lastError: null },
    storage: { local: area('local'), session: area('session') },
    identity: {
      getAuthToken: jest.fn((opts, cb) => {
        if (chromeResult.error) {
          chromeMock.runtime.lastError = { message: chromeResult.error };
          cb(undefined);
          chromeMock.runtime.lastError = null;
        } else {
          cb(chromeResult.token);
        }
      }),
      removeCachedAuthToken: jest.fn((opts, cb) => cb()),
      getRedirectURL: () => REDIRECT,
      launchWebAuthFlow: jest.fn((details, cb) => {
        const next = flows.shift();
        const answer = next ? next(new URL(details.url).searchParams, details) : { error: 'no flow scripted' };
        if (typeof answer === 'string') { cb(answer); return; }
        chromeMock.runtime.lastError = { message: answer.error };
        cb(undefined);
        chromeMock.runtime.lastError = null;
      }),
    },
  };
  return chromeMock;
}

let gmail;
function load(chromeMock) {
  jest.resetModules();
  global.chrome = chromeMock;
  gmail = require('../gmail.js');
}
afterEach(() => { delete global.chrome; });

const CHROME_NAV = { userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }] } };
const COMET_NAV = { userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Comet' }] } };
const flowCalls = () => chrome.identity.launchWebAuthFlow.mock.calls.map(([d]) => ({
  interactive: d.interactive, params: new URL(d.url).searchParams,
}));

describe('which sign-in is used', () => {
  test('Google Chrome with a Chrome account: Chrome sign-in only, no web window', async () => {
    load(makeChrome());
    expect(await gmail.getAuthToken({ clientId: CLIENT_ID, nav: CHROME_NAV })).toBe('chrome-token');
    expect(chrome.identity.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  test('"The user turned off browser signin" (Comet and friends): falls back to the web sign-in', async () => {
    load(makeChrome({ chromeResult: { error: 'The user turned off browser signin' }, flows: [grant()] }));
    expect(await gmail.getAuthToken({ clientId: CLIENT_ID, nav: CHROME_NAV })).toBe('web-1');
    const [call] = flowCalls();
    expect(call.interactive).toBe(true);
    expect(call.params.get('client_id')).toBe(CLIENT_ID);
    expect(call.params.get('redirect_uri')).toBe(REDIRECT);
    expect(call.params.get('response_type')).toBe('token id_token');
    expect(call.params.get('scope')).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(call.params.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(call.params.get('prompt')).toBeNull();
    // Cached for the session, and the account remembered for silent renewal.
    expect(chrome.areas.session.gmailToken).toMatchObject({ token: 'web-1' });
    expect(chrome.areas.session.gmailToken.expiresAt).toBeGreaterThan(Date.now() + 3000 * 1000);
    expect(chrome.areas.local.gmailAuth).toEqual({ method: 'web', loginHint: 'reader@gmail.com' });
  });

  test.each([
    'This API is not supported on Microsoft Edge.',
    "OAuth2 request failed: Service responded with error: 'bad client id: 1234'",
    'The user is not signed in.',
  ])('other Chrome-account failures also fall back: %s', async (message) => {
    load(makeChrome({ chromeResult: { error: message }, flows: [grant()] }));
    expect(await gmail.getAuthToken({ clientId: CLIENT_ID, nav: CHROME_NAV })).toBe('web-1');
  });

  test('a browser that says it is not Google Chrome skips Chrome sign-in entirely', async () => {
    load(makeChrome({ flows: [grant()] }));
    expect(await gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV })).toBe('web-1');
    expect(chrome.identity.getAuthToken).not.toHaveBeenCalled();
  });

  test('once the web sign-in has worked, later sign-ins go straight to it', async () => {
    load(makeChrome({ flows: [grant({ token: 'web-2' })] }));
    chrome.areas.local.gmailAuth = { method: 'web', loginHint: 'reader@gmail.com' };
    expect(await gmail.getAuthToken({ clientId: CLIENT_ID, nav: CHROME_NAV })).toBe('web-2');
    expect(chrome.identity.getAuthToken).not.toHaveBeenCalled();
  });

  test('cancelling Chrome sign-in does not open a second sign-in window', async () => {
    load(makeChrome({ chromeResult: { error: 'The user did not approve access.' } }));
    await expect(gmail.getAuthToken({ clientId: CLIENT_ID, nav: CHROME_NAV })).rejects.toThrow(/did not approve/);
    expect(chrome.identity.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  test('web client still the placeholder: one plain "not set up yet" error', async () => {
    load(makeChrome({ chromeResult: { error: 'The user turned off browser signin' } }));
    const placeholder = 'REPLACE_WITH_WEB_CLIENT_ID.apps.googleusercontent.com';
    expect(gmail.isWebClientConfigured(placeholder)).toBe(false);
    expect(gmail.isWebClientConfigured(gmail.WEB_OAUTH_CLIENT_ID)).toBe(true);
    await expect(gmail.getAuthToken({ clientId: placeholder, nav: CHROME_NAV })).rejects.toMatchObject({ code: 'web_auth_unconfigured' });
    expect(chrome.identity.launchWebAuthFlow).not.toHaveBeenCalled();
    const { friendlyError } = require('../background.js');
    expect(friendlyError({ code: 'web_auth_unconfigured', message: '' })).toMatch(/isn't set up yet/);
  });
});

describe('web sign-in: caching and renewal', () => {
  test('a fresh cached token is reused without any sign-in', async () => {
    load(makeChrome());
    chrome.areas.session.gmailToken = { token: 'cached', expiresAt: Date.now() + 600000 };
    expect(await gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV })).toBe('cached');
    expect(chrome.identity.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  test('an expired token is renewed silently (prompt=none, remembered account), no window', async () => {
    load(makeChrome({ flows: [grant({ token: 'renewed' })] }));
    chrome.areas.session.gmailToken = { token: 'old', expiresAt: Date.now() - 1 };
    chrome.areas.local.gmailAuth = { method: 'web', loginHint: 'reader@gmail.com' };
    expect(await gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV })).toBe('renewed');
    const calls = flowCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].interactive).toBe(false);
    expect(calls[0].params.get('prompt')).toBe('none');
    expect(calls[0].params.get('login_hint')).toBe('reader@gmail.com');
    expect(chrome.identity.launchWebAuthFlow.mock.calls[0][0]).toMatchObject({
      abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: expect.any(Number),
    });
  });

  test('silent renewal that needs the user falls back to the sign-in window', async () => {
    load(makeChrome({ flows: [
      () => ({ error: 'User interaction required.' }),
      grant({ token: 'after-window' }),
    ] }));
    chrome.areas.local.gmailAuth = { method: 'web', loginHint: 'reader@gmail.com' };
    expect(await gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV })).toBe('after-window');
    expect(flowCalls().map((c) => c.interactive)).toEqual([false, true]);
  });

  test('Google answering error=interaction_required to the silent try also leads to the window', async () => {
    load(makeChrome({ flows: [
      (p) => `${REDIRECT}#error=interaction_required&state=${p.get('state')}`,
      grant({ token: 'after-window' }),
    ] }));
    chrome.areas.local.gmailAuth = { method: 'web', loginHint: 'reader@gmail.com' };
    expect(await gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV })).toBe('after-window');
  });

  test('Gmail 401: the rejected token is dropped and the next sign-in renews once', async () => {
    load(makeChrome({ flows: [grant({ token: 'fresh' })] }));
    chrome.areas.session.gmailToken = { token: 'stale', expiresAt: Date.now() + 600000 };
    chrome.areas.local.gmailAuth = { method: 'web', loginHint: 'reader@gmail.com' };
    expect(await gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV })).toBe('stale');
    await gmail.removeCachedAuthToken('stale');
    expect(chrome.areas.session.gmailToken).toBeUndefined();
    expect(await gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV })).toBe('fresh');
    expect(flowCalls()).toHaveLength(1);
  });
});

describe('web sign-in: answers that are refused', () => {
  test('state mismatch (possible CSRF): refused, nothing cached', async () => {
    load(makeChrome({ flows: [(p) => grant()(new URLSearchParams({ state: 'forged', nonce: p.get('nonce') }))] }));
    await expect(gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV })).rejects.toMatchObject({ code: 'state_mismatch' });
    expect(chrome.areas.session.gmailToken).toBeUndefined();
  });

  test('id_token nonce mismatch: refused', async () => {
    load(makeChrome({ flows: [(p) => grant()(new URLSearchParams({ state: p.get('state'), nonce: 'other' }))] }));
    await expect(gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV })).rejects.toMatchObject({ code: 'state_mismatch' });
  });

  test('error=access_denied: the existing "sign-in was cancelled" message', async () => {
    load(makeChrome({ flows: [(p) => `${REDIRECT}#error=access_denied&state=${p.get('state')}`] }));
    const err = await gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV }).catch((e) => e);
    expect(err.code).toBe('cancelled');
    const { friendlyError } = require('../background.js');
    expect(friendlyError(err)).toMatch(/sign-in was cancelled/);
  });

  test('closing the sign-in window: the same cancelled message', async () => {
    load(makeChrome({ flows: [() => ({ error: 'The user did not approve access.' })] }));
    const err = await gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV }).catch((e) => e);
    const { friendlyError } = require('../background.js');
    expect(friendlyError(err)).toMatch(/sign-in was cancelled/);
  });

  test('send permission unticked on the consent screen: insufficient_scope, nothing cached', async () => {
    load(makeChrome({ flows: [grant({ scope: 'openid email' })] }));
    await expect(gmail.getAuthToken({ clientId: CLIENT_ID, nav: COMET_NAV })).rejects.toMatchObject({ code: 'insufficient_scope' });
    expect(chrome.areas.session.gmailToken).toBeUndefined();
  });
});

describe('isGoogleChrome', () => {
  test.each([
    [CHROME_NAV, true],
    [COMET_NAV, false],
    [{ userAgentData: { brands: [{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }] } }, false],
    [{}, true], // can't tell: try Chrome sign-in first, fall back on failure
  ])('%j -> %s', (nav, expected) => {
    load(makeChrome());
    expect(gmail.isGoogleChrome(nav)).toBe(expected);
  });
});
