/**
 * NSK web research against the real server, with real actor tokens. Stand-ins: one local "web" server
 * plays the public pages, SearXNG and Alpha Vantage; the ai-service stand-in answers turns and the
 * external knowledge index. Covered:
 *   - who may change the admin's lists (admin, IT administrator) and who may research live (roles with
 *     run_web_research); what everyone else may search (approved cached pages)
 *   - reading a page: kept as external knowledge (chunks indexed with URL, fetch date and approval),
 *     answered from the cache the second time, and the index being down not losing the answer
 *   - SSRF refusals: private and metadata addresses, a redirect into a private network, other schemes,
 *     credentials, other ports; blocked and not-allowed domains
 *   - the lists changing: pages of a newly blocked domain removed, approval following the allowlist
 *   - web search (blocked domains left out), stock quotes and their fallback, daily limits
 *   - web citations kept only for people who may read the page, expired pages cleaned up at startup,
 *     and the audit entries (never a query's text)
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WEB_RESEARCH_MESSAGES } from '../../constants/messages.js';
import { callNskTool, serverLogMatching, startNskStandIn, turnResponse } from './nskStandIn.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();
const QUERY_SECRET = 'confidential acquisition target pricing';
const ARTICLE = `<html><head><title>Rates</title></head><body><nav>Menu</nav><article>
  <h1>RBI policy rates, November 2026</h1>
  <p>The Reserve Bank of India kept the repo rate unchanged at its November meeting, the monetary policy committee said, and kept its stance neutral.</p>
  <h2>What it means</h2><p>Home and car loan rates are expected to stay where they are for now, bankers said after the announcement in Mumbai.</p>
  </article></body></html>`;

describe('NSK web research', { skip: skipReason ?? false }, () => {
  let web;
  let webPort;
  let standIn;
  let testServer;
  let admin;
  let itAdmin;
  let hr;
  let employee;
  const pageHits = [];
  const indexCalls = [];
  let failIndexing = false;
  let expiredSourceId;

  const collection = (name) => testServer.database.collection(name);
  const page = (path) => `http://127.0.0.1:${webPort}/pages${path}`;

  // Actor tokens live 120 seconds: one per client is reused for up to TOKEN_REUSE_MS, so the tool
  // calls stay within the per-minute message limit.
  const TOKEN_REUSE_MS = 90_000;
  const tokens = new Map();
  async function tokenOf(client) {
    const known = tokens.get(client);
    if (known && Date.now() - known.at < TOKEN_REUSE_MS) return known.token;
    const token = await freshTokenOf(client);
    tokens.set(client, { token, at: Date.now() });
    return token;
  }
  async function freshTokenOf(client) {
    let token;
    standIn.respond = indexOrTurn((body) => {
      token = body.actor_token;
      return turnResponse();
    });
    const response = await client.post('/api/nsk-bot/message', { message: 'hello' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return token;
  }
  const tool = async (client, name, args = {}) =>
    callNskTool(testServer, name, { actorToken: await tokenOf(client), args });

  /** The ai-service stand-in: the external knowledge index, else a turn answered by `answer`. */
  function indexOrTurn(answer) {
    return async (body, path) => {
      if (path.startsWith('/ai/external-knowledge/')) {
        indexCalls.push({ path, body });
        if (path.endsWith('/chunks')) {
          if (failIndexing) return { status: 503, body: { detail: 'Knowledge index unavailable' } };
          return { body: { indexed: body.chunks.length } };
        }
        if (path.endsWith('/approval')) return { body: { updated: body.source_ids.length } };
        return { body: { removed: body.source_ids?.length ?? 0 } };
      }
      return { body: await answer(body) };
    };
  }

  async function saveSettings(changes) {
    const current = await admin.get('/api/web-research/settings');
    const response = await admin.put('/api/web-research/settings', {
      allowedDomains: [],
      blockedDomains: [],
      allowUnlistedDomains: true,
      ...changes,
      version: current.body.data.settings.version,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data;
  }

  before(async () => {
    web = createServer((request, response) => {
      const url = new URL(request.url, 'http://local');
      if (url.pathname.startsWith('/pages/')) {
        pageHits.push(url.pathname);
        if (url.pathname === '/pages/rates') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(ARTICLE);
        } else if (url.pathname === '/pages/to-private') {
          response.writeHead(302, { Location: 'http://10.0.0.1/admin' }).end();
        } else if (url.pathname === '/pages/notes') {
          response.writeHead(200, { 'Content-Type': 'text/plain' }).end('Office notes.\n\nThe canteen opens at nine.');
        } else {
          response.writeHead(404).end();
        }
        return;
      }
      if (url.pathname === '/search') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            results: [
              { url: 'https://www.rbi.org.in/press', title: 'RBI press release', content: 'Repo rate unchanged.' },
              { url: 'https://blocked.example.com/x', title: 'Blocked', content: 'Should not appear.' },
              { url: 'ftp://files.example.com/x', title: 'FTP', content: 'Not http.' },
              { url: 'https://www.rbi.org.in/press', title: 'Duplicate', content: 'Same address.' },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/query') {
        const symbol = url.searchParams.get('symbol');
        const bodies = {
          'RELIANCE.BSE': {
            'Global Quote': {
              '01. symbol': 'RELIANCE.BSE',
              '05. price': '1412.35',
              '07. latest trading day': '2026-11-13',
              '09. change': '14.25',
              '10. change percent': '1.0193%',
            },
          },
          'TCS.NSE': { Information: 'Our standard API rate limit is 25 requests per day.' },
          'INFY.NSE': { 'Global Quote': {} },
        };
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(bodies[symbol] ?? {}));
        return;
      }
      response.writeHead(404).end();
    });
    web.listen(0, '127.0.0.1');
    await once(web, 'listening');
    webPort = web.address().port;

    standIn = await startNskStandIn();
    standIn.respond = indexOrTurn(() => turnResponse());
    testServer = await startTestServer({
      aiServiceUrl: standIn.url,
      environment: {
        LOG_LEVEL: 'info',
        SEARXNG_URL: `http://127.0.0.1:${webPort}`,
        ALPHA_VANTAGE_API_KEY: 'test-key',
        ALPHA_VANTAGE_BASE_URL: `http://127.0.0.1:${webPort}`,
        // The page server is on this machine: these let the fetcher reach it in this test only.
        WEB_FETCH_ALLOWED_PRIVATE_CIDRS: '127.0.0.1/32',
        WEB_FETCH_ALLOWED_PORTS: `80,443,${webPort}`,
        STOCK_QUOTE_DAILY_LIMIT: '4',
      },
      // An expired page left from before: the cleanup at startup removes it.
      seedBeforeStart: async (database) => {
        const now = Date.now();
        const { insertedId } = await database.collection('externalsources').insertOne({
          url: 'https://old.example.com/a',
          finalUrl: 'https://old.example.com/a',
          domain: 'old.example.com',
          title: 'Old',
          approved: true,
          fetchedAt: new Date(now - 10 * 86_400_000),
          expiresAt: new Date(now - 3 * 86_400_000),
          excerpt: 'old',
          sha256: 'a'.repeat(64),
          sizeBytes: 3,
          chunkCount: 1,
          indexed: true,
          fetchedByUserId: new database.base.Types.ObjectId(),
        });
        expiredSourceId = insertedId.toString();
      },
    });
    admin = await createSignedInClient(testServer, { name: 'Ada Admin', email: 'ada@example.com', role: 'admin' });
    itAdmin = await createSignedInClient(testServer, { name: 'Ivo IT', email: 'ivo@example.com', role: 'it_admin' });
    hr = await createSignedInClient(testServer, { name: 'Hari HR', email: 'hari@example.com', role: 'hr' });
    employee = await createSignedInClient(testServer, { name: 'Eli Employee', email: 'eli@example.com' });
  });

  after(async () => {
    await testServer?.stop();
    await standIn?.close();
    web?.close();
  });

  it('cleans up expired pages at startup, record and chunks', async () => {
    const deadline = Date.now() + 5_000;
    while ((await collection('externalsources').countDocuments({})) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await collection('externalsources').countDocuments({}), 0);
    const removal = indexCalls.find((call) => call.path.endsWith('/sources/remove'));
    assert.deepEqual(removal.body.source_ids, [expiredSourceId]);
    assert.ok(indexCalls.some((call) => call.path.endsWith('/expired/remove')));
  });

  it('lets administrators and IT change the lists, refusing others, overlaps and stale versions', async () => {
    for (const client of [hr, employee]) {
      assert.equal((await client.get('/api/web-research/settings')).status, 403);
    }
    const settings = (await itAdmin.get('/api/web-research/settings')).body.data.settings;
    assert.deepEqual(settings, {
      allowedDomains: [],
      blockedDomains: [],
      allowUnlistedDomains: true,
      version: settings.version,
      updatedAt: settings.updatedAt,
    });
    const overlap = await admin.put('/api/web-research/settings', {
      allowedDomains: ['rbi.org.in'],
      blockedDomains: ['RBI.org.in'],
      allowUnlistedDomains: true,
      version: settings.version,
    });
    assert.equal(overlap.status, 422);
    assert.equal(overlap.body.error.code, 'DOMAIN_IN_BOTH_LISTS');
    await saveSettings({ blockedDomains: ['blocked.example.com'] });
    const stale = await admin.put('/api/web-research/settings', {
      allowedDomains: [],
      blockedDomains: [],
      allowUnlistedDomains: true,
      version: settings.version,
    });
    assert.equal(stale.status, 409);
  });

  it('gives live research to roles with the capability only; everyone may search approved pages', async () => {
    for (const name of ['web_search', 'fetch_web_page', 'get_stock_quote']) {
      const refused = await tool(
        employee,
        name,
        name === 'get_stock_quote' ? { symbol: 'TCS' } : { query: 'x', url: 'x' },
      );
      assert.equal(refused.status, 403, name);
    }
    const employeeScope = await tool(employee, 'external_knowledge_scope');
    assert.equal(employeeScope.body.data.result.include_unapproved, false);
    assert.equal(employeeScope.body.data.result.note, WEB_RESEARCH_MESSAGES.CACHED_ONLY_NOTE);
    assert.equal((await tool(hr, 'external_knowledge_scope')).body.data.result.include_unapproved, true);
  });

  it('reads a page, keeps it as external knowledge, and answers it from the cache the second time', async () => {
    const response = await tool(hr, 'fetch_web_page', { url: page('/rates') });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const result = response.body.data.result;
    assert.equal(result.cached, false);
    assert.equal(result.approved, false);
    assert.equal(result.domain, '127.0.0.1');
    assert.match(result.text, /repo rate unchanged/);
    assert.doesNotMatch(result.text, /Menu/);
    assert.match(response.body.data.source, /fetched \d{4}-\d{2}-\d{2}$/);
    const indexed = indexCalls.filter((call) => call.path.endsWith('/chunks')).at(-1).body;
    assert.equal(indexed.source_id, result.source_id);
    assert.equal(indexed.source_url, page('/rates'));
    assert.equal(indexed.approved, false);
    assert.ok(new Date(indexed.expires_at) > new Date(indexed.fetched_at));
    const record = await collection('externalsources').findOne({ url: page('/rates') });
    assert.equal(record.indexed, true);
    assert.equal(record.chunkCount, indexed.chunks.length);

    const fetchesUsed = async () =>
      (await collection('webfetchusages').findOne({ userId: record.fetchedByUserId }))?.questions ?? 0;
    assert.equal(await fetchesUsed(), 1);
    const hits = pageHits.length;
    const again = await tool(hr, 'fetch_web_page', { url: page('/rates') });
    assert.equal(again.body.data.result.cached, true);
    assert.equal(pageHits.length, hits);
    // A cached answer spends none of the day's fetches.
    assert.equal(await fetchesUsed(), 1);

    // An expired copy is fetched again, and replaces the old one.
    await collection('externalsources').updateOne(
      { _id: record._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const refreshed = await tool(hr, 'fetch_web_page', { url: page('/rates') });
    assert.equal(refreshed.body.data.result.cached, false);
    assert.equal(pageHits.length, hits + 1);
    assert.equal(await fetchesUsed(), 2);
    assert.equal(await collection('externalsources').countDocuments({ url: page('/rates') }), 1);

    const log = await serverLogMatching(testServer, /"action":"nsk_web_research".*"kind":"fetch"/);
    assert.match(log, /"action":"nsk_web_research".*"domain":"127\.0\.0\.1"/);
    assert.doesNotMatch(log, /repo rate unchanged/);
  });

  it('refuses private addresses, redirects into private networks, other schemes, credentials and ports', async () => {
    const refusals = [
      [`http://127.0.0.2:${webPort}/pages/rates`, 'FETCH_PRIVATE_ADDRESS'],
      ['http://169.254.169.254/latest/meta-data/', 'FETCH_PRIVATE_ADDRESS'],
      [page('/to-private'), 'FETCH_PRIVATE_ADDRESS'],
      ['ftp://127.0.0.1/file', 'FETCH_SCHEME_NOT_ALLOWED'],
      [`http://user:secret@127.0.0.1:${webPort}/pages/rates`, 'FETCH_CREDENTIALS_NOT_ALLOWED'],
      ['http://127.0.0.1:6379/', 'FETCH_PORT_NOT_ALLOWED'],
    ];
    for (const [url, code] of refusals) {
      const refused = await tool(hr, 'fetch_web_page', { url });
      assert.equal(refused.status, 422, url);
      assert.equal(refused.body.error.code, code, url);
      assert.equal(refused.body.error.message, WEB_RESEARCH_MESSAGES.FETCH_REFUSED[code.slice('FETCH_'.length)]);
    }
  });

  it('follows the lists: approval changes, blocked pages removed, unlisted sites closed', async () => {
    const source = await collection('externalsources').findOne({ url: page('/rates') });
    const approved = await saveSettings({ allowedDomains: ['127.0.0.1'] });
    assert.equal(approved.synced.approved, 1);
    const approval = indexCalls.filter((call) => call.path.endsWith('/approval')).at(-1).body;
    assert.deepEqual(approval, { source_ids: [source._id.toString()], approved: true });
    assert.equal((await collection('externalsources').findOne({ _id: source._id })).approved, true);

    const blocked = await saveSettings({ blockedDomains: ['127.0.0.1'] });
    assert.equal(blocked.synced.removed, 1);
    assert.equal(await collection('externalsources').countDocuments({ _id: source._id }), 0);
    const refused = await tool(hr, 'fetch_web_page', { url: page('/rates') });
    assert.equal(refused.body.error.code, 'FETCH_DOMAIN_BLOCKED');

    await saveSettings({ allowUnlistedDomains: false });
    const closed = await tool(hr, 'fetch_web_page', { url: page('/notes') });
    assert.equal(closed.body.error.code, 'FETCH_DOMAIN_NOT_ALLOWED');

    await saveSettings({ allowedDomains: ['127.0.0.1'], allowUnlistedDomains: false });
    const reread = await tool(hr, 'fetch_web_page', { url: page('/rates') });
    assert.equal(reread.status, 200);
    assert.equal(reread.body.data.result.approved, true);
  });

  it('still answers a page when the index is down, and keeps it for the same person', async () => {
    failIndexing = true;
    try {
      const response = await tool(hr, 'fetch_web_page', { url: page('/notes') });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.result.note, WEB_RESEARCH_MESSAGES.INDEX_UNAVAILABLE);
      assert.match(response.body.data.result.text, /canteen opens at nine/);
      const record = await collection('externalsources').findOne({ url: page('/notes') });
      assert.equal(record.indexed, false);
    } finally {
      failIndexing = false;
    }
  });

  it('searches the web without blocked or non-http results, auditing only the query length', async () => {
    await saveSettings({ allowedDomains: ['127.0.0.1'], blockedDomains: ['blocked.example.com'] });
    const response = await tool(hr, 'web_search', { query: QUERY_SECRET });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(
      response.body.data.result.results.map((result) => result.url),
      ['https://www.rbi.org.in/press'],
    );
    assert.match(response.body.data.source, /^Web search:/);
    const log = await serverLogMatching(testServer, /"kind":"search"/);
    assert.match(log, new RegExp(`"queryLength":${QUERY_SECRET.length}`));
    const auditLines = log.split('\n').filter((line) => line.includes('"action":"nsk_web_research"'));
    for (const line of auditLines) assert.doesNotMatch(line, /acquisition/);
  });

  it('quotes stocks, falls back to search snippets when the provider cannot answer, and keeps to the daily limit', async () => {
    const quote = await tool(hr, 'get_stock_quote', { symbol: 'reliance', exchange: 'BSE' });
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal(quote.body.data.result.kind, 'quote');
    assert.equal(quote.body.data.result.quote.price, 1412.35);
    assert.equal(quote.body.data.source, 'RELIANCE on BSE, Alpha Vantage, 2026-11-13');

    const limited = await tool(hr, 'get_stock_quote', { symbol: 'TCS' });
    assert.equal(limited.body.data.result.kind, 'search_fallback');
    assert.equal(
      limited.body.data.result.note,
      WEB_RESEARCH_MESSAGES.QUOTE_FALLBACK_NOTE(WEB_RESEARCH_MESSAGES.QUOTE_FALLBACK_REASONS.rate_limited),
    );
    assert.equal(limited.body.data.result.results.length, 1);
    const noData = await tool(hr, 'get_stock_quote', { symbol: 'INFY', exchange: 'NSE' });
    assert.match(noData.body.data.result.note, /has no data for this symbol/);

    assert.equal((await tool(hr, 'get_stock_quote', { symbol: 'not a symbol!' })).status, 400);
    assert.equal((await tool(hr, 'get_stock_quote', { symbol: 'TCS', exchange: 'NYSE' })).status, 400);
    assert.equal((await tool(hr, 'get_stock_quote', { symbol: 'WIPRO' })).status, 200);
    const overLimit = await tool(hr, 'get_stock_quote', { symbol: 'HDFCBANK' });
    assert.equal(overLimit.status, 429);
    assert.equal(overLimit.body.error.code, 'WEB_DAILY_LIMIT');
  });

  it('keeps a web citation only for people who may read the page', async () => {
    const approvedSource = await collection('externalsources').findOne({ url: page('/rates') });
    const unapproved = await tool(itAdmin, 'fetch_web_page', { url: page('/notes') });
    assert.equal(unapproved.status, 200);
    await saveSettings({ allowedDomains: [], blockedDomains: [], allowUnlistedDomains: true });
    await saveSettings({ allowedDomains: ['127.0.0.1'] });
    // Make the notes page unapproved again while rates stays approved: notes is kept for live research.
    await collection('externalsources').updateOne({ url: page('/notes') }, { $set: { approved: false } });
    const citing = indexOrTurn(() =>
      turnResponse({
        reply: 'The repo rate was kept unchanged [1]. The canteen opens at nine [2].',
        sources: [
          {
            number: 1,
            kind: 'web',
            source_id: approvedSource._id.toString(),
            url: 'x',
            title: 'x',
            fetched_at: 'x',
            excerpt: 'repo',
          },
          {
            number: 2,
            kind: 'web',
            source_id: unapproved.body.data.result.source_id,
            url: 'x',
            title: 'x',
            fetched_at: 'x',
            excerpt: 'canteen',
          },
        ],
      }),
    );
    standIn.respond = citing;
    const byEmployee = await employee.post('/api/nsk-bot/message', { message: 'What is the repo rate?' });
    assert.equal(byEmployee.status, 200, JSON.stringify(byEmployee.body));
    const employeeCitations = byEmployee.body.data.message.citations;
    assert.deepEqual(
      employeeCitations.map((citation) => [citation.kind, citation.externalSourceId]),
      [['WEB', approvedSource._id.toString()]],
    );
    assert.equal(employeeCitations[0].sourceUrl, page('/rates'));
    assert.ok(employeeCitations[0].fetchedAt);
    assert.match(employeeCitations[0].label, /\(127\.0\.0\.1\), fetched \d{4}-\d{2}-\d{2}$/);
    standIn.respond = citing;
    const byHr = await hr.post('/api/nsk-bot/message', { message: 'What is the repo rate?' });
    assert.equal(byHr.body.data.message.citations.length, 2);
    // An expired page is no longer cited, even for live research.
    await collection('externalsources').updateOne(
      { _id: approvedSource._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    standIn.respond = citing;
    const afterExpiry = await hr.post('/api/nsk-bot/message', { message: 'What is the repo rate?' });
    assert.deepEqual(
      afterExpiry.body.data.message.citations.map((citation) => citation.externalSourceId),
      [unapproved.body.data.result.source_id],
    );
  });

  it('lists cached pages for administrators and removes one with its chunks', async () => {
    const listed = await admin.get('/api/web-research/sources');
    assert.equal(listed.status, 200);
    const notes = listed.body.data.sources.find((source) => source.url === page('/notes'));
    assert.ok(notes);
    const removed = await admin.delete(`/api/web-research/sources/${notes.id}`);
    assert.equal(removed.status, 200);
    assert.equal(await collection('externalsources').countDocuments({ url: page('/notes') }), 0);
    assert.deepEqual(indexCalls.filter((call) => call.path.endsWith('/sources/remove')).at(-1).body, {
      source_ids: [notes.id],
    });
    assert.equal((await admin.delete(`/api/web-research/sources/${notes.id}`)).status, 404);
    assert.equal((await hr.get('/api/web-research/sources')).status, 403);
  });
});
