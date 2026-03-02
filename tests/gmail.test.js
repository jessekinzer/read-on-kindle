'use strict';

const { makeMultipartMime, base64UrlEncode } = require('../gmail.js');

describe('base64UrlEncode', () => {
  test('produces no +, /, or = characters', () => {
    // Standard base64 uses +, /, = — URL-safe must not
    const result = base64UrlEncode('hello world this is a test string');
    expect(result).not.toMatch(/[+/=]/);
  });

  test('encodes ASCII correctly', () => {
    const input = 'test';
    const encoded = base64UrlEncode(input);
    // Reverse: add padding, swap back to standard base64, decode
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
    const standard = padded.replace(/-/g, '+').replace(/_/g, '/');
    expect(Buffer.from(standard, 'base64').toString('utf8')).toBe(input);
  });
});

describe('makeMultipartMime', () => {
  let result;

  beforeAll(() => {
    result = makeMultipartMime(
      'test@kindle.com',
      'My Article',
      '<html><body>Hello</body></html>',
      'my-article.html'
    );
  });

  test('contains To header', () => {
    expect(result).toContain('To: test@kindle.com');
  });

  test('contains Subject header', () => {
    expect(result).toContain('Subject: My Article');
  });

  test('contains multipart/mixed content type', () => {
    expect(result).toContain('multipart/mixed');
  });

  test('contains attachment filename', () => {
    expect(result).toContain('my-article.html');
  });

  test('contains base64 transfer encoding', () => {
    expect(result).toContain('Content-Transfer-Encoding: base64');
  });

  test('contains attachment disposition', () => {
    expect(result).toContain('Content-Disposition: attachment');
  });

  test('uses CRLF line endings (RFC 2822)', () => {
    expect(result).toContain('\r\n');
  });

  test('attachment body decodes back to original HTML', () => {
    const html = '<html><body>Hello</body></html>';
    const mime = makeMultipartMime('test@kindle.com', 'My Article', html, 'my-article.html');
    // Extract the base64 block: the lines after 'Content-Transfer-Encoding: base64' and the blank line
    const lines = mime.split('\r\n');
    const b64StartIdx = lines.indexOf('Content-Transfer-Encoding: base64') + 2; // +1 for blank line
    // Collect lines until next MIME boundary or end
    const b64Lines = [];
    for (let i = b64StartIdx; i < lines.length; i++) {
      if (lines[i].startsWith('--') || lines[i] === '') break;
      b64Lines.push(lines[i]);
    }
    const decoded = Buffer.from(b64Lines.join(''), 'base64').toString('utf8');
    expect(decoded).toBe(html);
  });
});
