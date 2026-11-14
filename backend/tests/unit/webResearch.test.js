/**
 * Web research pieces that need no database: which addresses and URLs the page fetcher may reach,
 * the admin's domain lists, the fetcher itself against a local server with DNS answered by the test
 * (private addresses refused before connecting, every redirect checked, the connection pinned to the
 * checked address, size, time, type and status limits), readable text extraction, the quote provider's
 * answers (a quote, its free limit used up, no data) and the settings validator.
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractPage } from '../../services/webResearch/pageExtraction.js';
import { fetchPublicPage } from '../../services/webResearch/safeFetch.js';
import { FALLBACK_REASONS, QuoteProviderError, alphaVantageProvider } from '../../services/webResearch/stockQuotes.js';
import {
  DOMAIN_POLICIES,
  FETCH_ERROR_CODES as E,
  WebFetchError,
  allowedRangesOf,
  assertDomainAllowed,
  domainPolicyOf,
  embeddedIpv4,
  hostIsWithin,
  isPublicAddress,
  normalizeDomain,
  normalizeUrl,
} from '../../services/webResearch/urlSafety.js';
import { validateWebResearchSettings } from '../../validators/webResearchValidators.js';

const codeOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WebFetchError, `expected a WebFetchError, got ${error}`);
    return error.code;
  }
  return null;
};
const syncCode = (run) => {
  try {
    run();
  } catch (error) {
    return error.code;
  }
  return null;
};

describe('addresses the fetcher may reach', () => {
  it('refuses every address that is not on the public internet', () => {
    for (const address of [
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '198.18.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      'not-an-ip',
    ]) {
      assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(isPublicAddress(address), true, address);
    }
  });

  it('judges IPv6 forms that carry an IPv4 address by that address', () => {
    assert.equal(embeddedIpv4('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(embeddedIpv4('::ffff:7f00:1'), '127.0.0.1');
    assert.equal(embeddedIpv4('64:ff9b::a9fe:a9fe'), '169.254.169.254');
    assert.equal(embeddedIpv4('2002:0a00:0001::'), '10.0.0.1');
    assert.equal(embeddedIpv4('2001:0:4136:e378:8000:63bf:80ff:fffe'), '127.0.0.1');
    assert.equal(embeddedIpv4('2606:4700::1111'), null);
    for (const address of ['::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a9fe:a9fe::1', '2001:0:1:2:3:4:80ff:fffe']) {
      assert.equal(isPublicAddress(address), false, address);
    }
  });

  it('lets through only the private ranges a deployment lists', () => {
    const ranges = allowedRangesOf(['10.20.0.0/16', 'fd12::/16']);
    assert.equal(isPublicAddress('10.20.5.5', ranges), true);
    assert.equal(isPublicAddress('10.21.5.5', ranges), false);
    assert.equal(isPublicAddress('fd12::5', ranges), true);
    assert.equal(isPublicAddress('::ffff:10.20.5.5', ranges), true);
  });
});

describe('URLs and the domain lists', () => {
  it('accepts http(s) on the allowed ports, normalised, and refuses the rest with a reason', () => {
    assert.deepEqual(normalizeUrl(' HTTPS://Example.COM./a?b=1#top '), {
      url: 'https://example.com/a?b=1',
      hostname: 'example.com',
    });
    assert.equal(normalizeUrl('http://[::1]/x').hostname, '::1');
    assert.equal(
      syncCode(() => normalizeUrl('ftp://example.com/')),
      E.SCHEME_NOT_ALLOWED,
    );
    assert.equal(
      syncCode(() => normalizeUrl('file:///etc/passwd')),
      E.SCHEME_NOT_ALLOWED,
    );
    assert.equal(
      syncCode(() => normalizeUrl('javascript:alert(1)')),
      E.SCHEME_NOT_ALLOWED,
    );
    assert.equal(
      syncCode(() => normalizeUrl('https://user:pass@example.com/')),
      E.CREDENTIALS_NOT_ALLOWED,
    );
    assert.equal(
      syncCode(() => normalizeUrl('http://example.com:6379/')),
      E.PORT_NOT_ALLOWED,
    );
    assert.equal(normalizeUrl('http://example.com:6379/', { allowedPorts: [6379] }).hostname, 'example.com');
    assert.equal(
      syncCode(() => normalizeUrl('not a url')),
      E.INVALID_URL,
    );
    assert.equal(
      syncCode(() => normalizeUrl(`https://example.com/${'a'.repeat(2100)}`)),
      E.INVALID_URL,
    );
  });

  it('normalises list entries, domains or IP addresses', () => {
    assert.equal(normalizeDomain(' WWW.RBI.org.in. '), 'www.rbi.org.in');
    assert.equal(normalizeDomain('10.0.0.1'), '10.0.0.1');
    for (const bad of ['localhost', 'bad_domain.com', '-x.com', 'http://x.com', '', 42]) {
      assert.equal(normalizeDomain(bad), null, String(bad));
    }
  });

  it('covers subdomains, never look-alikes', () => {
    assert.equal(hostIsWithin('www.rbi.org.in', 'rbi.org.in'), true);
    assert.equal(hostIsWithin('rbi.org.in', 'rbi.org.in'), true);
    assert.equal(hostIsWithin('evilrbi.org.in', 'rbi.org.in'), false);
    assert.equal(hostIsWithin('10.0.0.1', '10.0.0.1'), true);
    assert.equal(hostIsWithin('110.0.0.1', '10.0.0.1'), false);
    // A DNS name ending in an allowed IP address is not that address.
    assert.equal(hostIsWithin('attacker.10.0.0.1', '10.0.0.1'), false);
  });

  it('applies the blocklist first, then the allowlist, then the unlisted rule', () => {
    const settings = { allowedDomains: ['rbi.org.in'], blockedDomains: ['bad.rbi.org.in'], allowUnlistedDomains: true };
    assert.equal(domainPolicyOf('www.rbi.org.in', settings), DOMAIN_POLICIES.APPROVED);
    assert.equal(domainPolicyOf('bad.rbi.org.in', settings), DOMAIN_POLICIES.BLOCKED);
    assert.equal(domainPolicyOf('news.example.com', settings), DOMAIN_POLICIES.UNLISTED);
    const closed = { ...settings, allowUnlistedDomains: false };
    assert.equal(domainPolicyOf('news.example.com', closed), DOMAIN_POLICIES.NOT_ALLOWED);
    assert.equal(
      syncCode(() => assertDomainAllowed('bad.rbi.org.in', closed)),
      E.DOMAIN_BLOCKED,
    );
    assert.equal(
      syncCode(() => assertDomainAllowed('news.example.com', closed)),
      E.DOMAIN_NOT_ALLOWED,
    );
  });

  it('validates the admin’s settings: domains normalised and de-duplicated', () => {
    const valid = validateWebResearchSettings({
      allowedDomains: ['RBI.org.in', 'rbi.org.in', 'nseindia.com'],
      blockedDomains: ['10.0.0.1'],
      allowUnlistedDomains: false,
      version: 0,
    });
    assert.equal(valid.isValid, true);
    assert.deepEqual(valid.sanitizedInput.changes.allowedDomains, ['nseindia.com', 'rbi.org.in']);
    const invalid = validateWebResearchSettings({ allowedDomains: ['not a domain'], blockedDomains: 'x', extra: 1 });
    assert.deepEqual(invalid.validationErrors.map((error) => error.field).sort(), [
      'allowUnlistedDomains',
      'allowedDomains[0]',
      'blockedDomains',
      'extra',
      'version',
    ]);
  });
});

describe('fetching a page', () => {
  let server;
  let port;
  const requests = [];
  const allowLoopback = allowedRangesOf(['127.0.0.1/32']);
  const allowAll = () => {};
  // DNS answered by the test: every name is the local server unless the test says otherwise.
  // An IP address resolves to itself, as with the system resolver.
  const resolveTo =
    (...addresses) =>
    async (hostname) =>
      (isIP(hostname) ? [hostname] : addresses).map((address) => ({ address, family: isIP(address) }));
  const options = (overrides = {}) => ({
    checkHost: allowAll,
    allowedRanges: allowLoopback,
    allowedPorts: [port],
    resolve: resolveTo('127.0.0.1'),
    ...overrides,
  });
  const ARTICLE = `<html><head><title>Repo rate</title></head><body><nav>Home Markets About</nav><article>
    <h1>RBI keeps the repo rate at 5.25%</h1>
    <p>The Reserve Bank of India kept its key repo rate unchanged on Friday, its monetary policy committee said after a three-day meeting in Mumbai.</p>
    <h2>Inflation</h2><p>Retail inflation eased in October and stayed within the target band, giving the central bank room to support growth this year.</p>
    </article><footer>Copyright</footer><script>steal()</script></body></html>`;

  before(async () => {
    server = createServer((request, response) => {
      requests.push({ url: request.url, host: request.headers.host, userAgent: request.headers['user-agent'] });
      const routes = {
        '/article': () => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(ARTICLE),
        '/plain': () => response.writeHead(200, { 'Content-Type': 'text/plain' }).end('First para.\n\nSecond para.'),
        '/to-article': () => response.writeHead(302, { Location: '/article' }).end(),
        '/to-metadata': () => response.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }).end(),
        '/to-blocked': () => response.writeHead(301, { Location: `http://blocked.example:${port}/article` }).end(),
        '/loop': () => response.writeHead(302, { Location: '/loop' }).end(),
        '/image': () => response.writeHead(200, { 'Content-Type': 'image/png' }).end('png'),
        '/big': () => response.writeHead(200, { 'Content-Type': 'text/html' }).end('x'.repeat(5000)),
        '/declared-big': () =>
          response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '999999999' }).end(),
        '/slow': () => setTimeout(() => response.writeHead(200, { 'Content-Type': 'text/html' }).end('late'), 1500),
        '/missing': () => response.writeHead(404, { 'Content-Type': 'text/html' }).end('gone'),
      };
      (routes[request.url] ?? routes['/missing'])();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
  });

  after(() => server.close());

  it('reads a page on an allowed address, connecting to the address that was checked', async () => {
    const page = await fetchPublicPage(`http://news.example:${port}/article`, options());
    assert.equal(page.hostname, 'news.example');
    assert.equal(page.contentType, 'text/html');
    assert.match(page.text, /repo rate unchanged/);
    const request = requests.at(-1);
    // The name was never resolved by the system: the request reached 127.0.0.1 with the original host.
    assert.equal(request.host, `news.example:${port}`);
    assert.match(request.userAgent, /NSKResearchBot/);
  });

  it('refuses a name that resolves to a private address, even alongside a public one, before connecting', async () => {
    const before = requests.length;
    assert.equal(
      await codeOf(
        fetchPublicPage(`http://intranet.example:${port}/article`, options({ resolve: resolveTo('10.0.0.5') })),
      ),
      E.PRIVATE_ADDRESS,
    );
    assert.equal(
      await codeOf(
        fetchPublicPage(
          `http://mixed.example:${port}/article`,
          options({ resolve: resolveTo('8.8.8.8', '127.0.0.2') }),
        ),
      ),
      E.PRIVATE_ADDRESS,
    );
    assert.equal(
      await codeOf(
        fetchPublicPage(`http://127.0.0.1:${port}/article`, options({ allowedRanges: allowedRangesOf([]) })),
      ),
      E.PRIVATE_ADDRESS,
    );
    assert.equal(requests.length, before);
  });

  it('checks every redirect: followed when allowed, refused into private networks or blocked sites', async () => {
    const page = await fetchPublicPage(`http://news.example:${port}/to-article`, options());
    assert.match(page.finalUrl, /\/article$/);
    assert.equal(
      await codeOf(fetchPublicPage(`http://news.example:${port}/to-metadata`, options({ allowedPorts: [port, 80] }))),
      E.PRIVATE_ADDRESS,
    );
    const checkHost = (hostname) => {
      if (hostname === 'blocked.example') throw new WebFetchError(E.DOMAIN_BLOCKED);
    };
    assert.equal(
      await codeOf(fetchPublicPage(`http://news.example:${port}/to-blocked`, options({ checkHost }))),
      E.DOMAIN_BLOCKED,
    );
    const beforeLoop = requests.length;
    assert.equal(await codeOf(fetchPublicPage(`http://news.example:${port}/loop`, options())), E.TOO_MANY_REDIRECTS);
    // The first request and five redirects, no more.
    assert.equal(requests.length - beforeLoop, 6);
  });

  it('refuses other content types, oversized bodies, slow sites, error statuses and failed lookups', async () => {
    assert.equal(await codeOf(fetchPublicPage(`http://news.example:${port}/image`, options())), E.UNSUPPORTED_CONTENT);
    assert.equal(
      await codeOf(fetchPublicPage(`http://news.example:${port}/big`, options({ maxBytes: 1000 }))),
      E.TOO_LARGE,
    );
    assert.equal(await codeOf(fetchPublicPage(`http://news.example:${port}/declared-big`, options())), E.TOO_LARGE);
    assert.equal(
      await codeOf(fetchPublicPage(`http://news.example:${port}/slow`, options({ timeoutMs: 300 }))),
      E.TIMEOUT,
    );
    const missing = fetchPublicPage(`http://news.example:${port}/missing`, options());
    await assert.rejects(missing, (error) => error.code === E.HTTP_ERROR && error.details.status === 404);
    const failing = async () => {
      throw new Error('ENOTFOUND');
    };
    assert.equal(
      await codeOf(fetchPublicPage(`http://nowhere.example:${port}/`, options({ resolve: failing }))),
      E.DNS_FAILED,
    );
    assert.equal(
      await codeOf(fetchPublicPage(`http://news.example:${port}/article`, options({ allowedPorts: [80] }))),
      E.PORT_NOT_ALLOWED,
    );
  });

  it('extracts the readable text without menus or scripts, and splits plain text into paragraphs', async () => {
    const page = await fetchPublicPage(`http://news.example:${port}/article`, options());
    const extracted = extractPage(page);
    assert.match(extracted.title, /repo rate/i);
    assert.match(extracted.text, /Reserve Bank of India/);
    assert.doesNotMatch(extracted.text, /steal\(\)|Copyright|Home Markets/);
    assert.ok(extracted.blocks.some((block) => block.type === 'heading' && /Inflation/.test(block.text)));
    const plain = extractPage(await fetchPublicPage(`http://news.example:${port}/plain`, options()));
    assert.equal(plain.title, 'news.example');
    assert.deepEqual(
      plain.blocks.map((block) => block.text),
      ['First para.', 'Second para.'],
    );
  });
});

describe('readable text', () => {
  it('never takes text from attributes, and reads nested blocks once', () => {
    const html = `<html><head><title>T</title></head><body><article>
      <h2 data-mw='{"x":"a > b [[File:Secret.svg]]"}'>Heading</h2>
      <p title="1 > 0 [[wikitext]]">Visible text only.</p>
      <ul><li><p>Inside a list item.</p></li></ul>
      <p>Short.</p><script>alert(1)</script></article></body></html>`;
    const extracted = extractPage({ text: html, contentType: 'text/html', url: 'https://example.com/a' });
    assert.doesNotMatch(extracted.text, /\[\[|Secret|wikitext|alert/);
    const texts = extracted.blocks.map((block) => block.text);
    assert.ok(texts.includes('Heading'));
    assert.ok(texts.includes('Visible text only.'));
    assert.equal(texts.filter((text) => text === 'Inside a list item.').length, 1);
  });
});

describe('the quote provider', () => {
  const answering =
    (body, status = 200) =>
    async () =>
      new Response(JSON.stringify(body), { status });
  const provider = (body, status) =>
    alphaVantageProvider({ apiKey: 'k', baseUrl: 'https://av.example' }, { fetchImpl: answering(body, status) });

  it('reads a quote, asking for SYMBOL.EXCHANGE', async () => {
    let asked;
    const quoting = alphaVantageProvider(
      { apiKey: 'k', baseUrl: 'https://av.example' },
      {
        fetchImpl: async (url) => {
          asked = new URL(url);
          return new Response(
            JSON.stringify({
              'Global Quote': {
                '01. symbol': 'RELIANCE.BSE',
                '02. open': '1400.00',
                '05. price': '1412.35',
                '07. latest trading day': '2026-11-13',
                '08. previous close': '1398.10',
                '09. change': '14.25',
                '10. change percent': '1.0193%',
              },
            }),
          );
        },
      },
    );
    const quote = await quoting.getQuote('RELIANCE', 'BSE');
    assert.equal(asked.searchParams.get('symbol'), 'RELIANCE.BSE');
    assert.equal(asked.searchParams.get('function'), 'GLOBAL_QUOTE');
    assert.equal(quote.price, 1412.35);
    assert.equal(quote.changePercent, 1.0193);
    assert.equal(quote.latestTradingDay, '2026-11-13');
  });

  it('reports its free limit used up, no data, and failures', async () => {
    for (const body of [
      { Information: 'standard API rate limit is 25 requests per day' },
      { Note: 'call frequency' },
    ]) {
      await assert.rejects(provider(body).getQuote('TCS', 'NSE'), (error) => {
        return error instanceof QuoteProviderError && error.reason === FALLBACK_REASONS.RATE_LIMITED;
      });
    }
    assert.equal(await provider({ 'Global Quote': {} }).getQuote('TCS', 'NSE'), null);
    assert.equal(await provider({ 'Error Message': 'Invalid API call' }).getQuote('TCS', 'NSE'), null);
    await assert.rejects(
      provider({}, 500).getQuote('TCS', 'NSE'),
      (error) => error.reason === FALLBACK_REASONS.UNAVAILABLE,
    );
  });
});
