/**
 * Web search through the company's own SearXNG (self-hosted, AGPL-3.0, docker-compose*.yml), its JSON
 * API: GET {SEARXNG_URL}/search?q=…&format=json. SearXNG is a configured internal service, not an
 * address from a user, so it is called directly.
 *
 * searchWeb({ query, config, settings }) → [{ title, url, domain, snippet, published }]
 *   at most SEARCH_RESULTS_MAX; http(s) results only; results from blocked domains left out; snippets
 *   cut at SNIPPET_MAX_LENGTH. Without SEARXNG_URL: 503 SEARCH_UNAVAILABLE. SearXNG failing or slow
 *   (PROVIDER_TIMEOUT_MS): 503 SEARCH_FAILED.
 */

import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { WEB_RESEARCH_MESSAGES as M } from '../../constants/messages.js';
import { WEB_RESEARCH_SETTINGS as S } from '../../constants/validation.js';
import { logger } from '../../utils/logger.js';
import { ServiceError } from '../serviceError.js';
import { DOMAIN_POLICIES, domainPolicyOf } from './urlSafety.js';

const collapse = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');

function resultOf(raw, settings) {
  if (typeof raw?.url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(raw.url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const domain = parsed.hostname.toLowerCase();
  if (domainPolicyOf(domain, settings) === DOMAIN_POLICIES.BLOCKED) return null;
  return {
    title: collapse(raw.title).slice(0, S.TITLE_MAX_LENGTH) || domain,
    url: parsed.toString(),
    domain,
    snippet: collapse(raw.content).slice(0, S.SNIPPET_MAX_LENGTH),
    published: typeof raw.publishedDate === 'string' ? raw.publishedDate.slice(0, 10) : null,
  };
}

/**
 * @param {{ query: string, config: object, settings: object }} request
 * @returns {Promise<object[]>}
 */
export async function searchWeb({ query, config, settings }) {
  const baseUrl = config.webResearch.searxngUrl;
  if (!baseUrl) throw new ServiceError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'SEARCH_UNAVAILABLE', M.SEARCH_UNAVAILABLE);
  const params = new URLSearchParams({ q: query, format: 'json', safesearch: '1', categories: 'general' });
  let body;
  try {
    const response = await fetch(`${baseUrl}/search?${params}`, {
      // SearXNG's bot detection expects the caller's address; the caller is this backend.
      headers: { Accept: 'application/json', 'X-Real-IP': '127.0.0.1' },
      signal: AbortSignal.timeout(S.PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`SearXNG answered ${response.status}`);
    body = await response.json();
  } catch (searchError) {
    logger.warn('Web search failed', { error: { name: searchError.name, message: searchError.message } });
    throw new ServiceError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'SEARCH_FAILED', M.SEARCH_FAILED);
  }
  const seen = new Set();
  const results = [];
  for (const raw of Array.isArray(body?.results) ? body.results : []) {
    const result = resultOf(raw, settings);
    if (!result || seen.has(result.url)) continue;
    seen.add(result.url);
    results.push(result);
    if (results.length === S.SEARCH_RESULTS_MAX) break;
  }
  return results;
}
