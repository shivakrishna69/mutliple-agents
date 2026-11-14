/**
 * Reads one public web page for NSK, refusing anything that could reach inside the company's or the
 * cloud's networks (server-side request forgery):
 *
 *   1. The URL is checked (urlSafety.js normalizeUrl) and so is its domain against the admin's lists
 *      (the `checkHost` callback).
 *   2. The host name is resolved first (every address, IPv4 and IPv6). If any address is not public
 *      the page is refused: a name with one public and one private address is not a page to read.
 *   3. The connection is made to the address that was checked (a custom `lookup`), so the name cannot
 *      be resolved again to somewhere else in between (DNS rebinding). TLS still verifies the
 *      certificate for the host name.
 *   4. Redirects are followed by hand, at most MAX_REDIRECTS, each new URL going through 1-3 again.
 *   5. The whole fetch, redirects included, has FETCH_TIMEOUT_MS; a body over FETCH_MAX_BYTES is
 *      refused (by Content-Length when sent, and as it streams); only CONTENT_TYPES are read; the body
 *      is asked for uncompressed, so its size is its size.
 *
 * fetchPublicPage(url, options) → { url, finalUrl, hostname, contentType, text, sizeBytes }
 * Every refusal is a WebFetchError with a code (urlSafety.js FETCH_ERROR_CODES).
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { WEB_RESEARCH_SETTINGS as S } from '../../constants/validation.js';
import { FETCH_ERROR_CODES as E, WebFetchError, isPublicAddress, normalizeUrl } from './urlSafety.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The addresses `hostname` resolves to, each checked; the first is the one connected to. */
async function resolvePublicAddresses(hostname, { resolve, allowedRanges, signal }) {
  let addresses;
  // DNS lookups take no signal: the fetch's deadline still applies to them.
  const deadline = new Promise((resolveDeadline, rejectDeadline) => {
    if (signal.aborted) rejectDeadline(new WebFetchError(E.TIMEOUT));
    signal.addEventListener('abort', () => rejectDeadline(new WebFetchError(E.TIMEOUT)), { once: true });
  });
  deadline.catch(() => {});
  try {
    addresses = await Promise.race([resolve(hostname, { all: true, verbatim: true }), deadline]);
  } catch (lookupError) {
    if (lookupError instanceof WebFetchError) throw lookupError;
    throw new WebFetchError(E.DNS_FAILED);
  }
  if (!addresses?.length) throw new WebFetchError(E.DNS_FAILED);
  if (addresses.some(({ address }) => !isPublicAddress(address, allowedRanges))) {
    throw new WebFetchError(E.PRIVATE_ADDRESS);
  }
  return addresses;
}

function charsetOf(contentType) {
  const match = /charset=["']?([\w-]+)/i.exec(contentType ?? '');
  return match ? match[1].toLowerCase() : 'utf-8';
}

function decode(bytes, contentType) {
  try {
    return new TextDecoder(charsetOf(contentType), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** One request to a checked address; resolves with the response (body unread) or rejects. */
function requestOnce(target, pinned, signal) {
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: 'GET',
        signal,
        headers: {
          'User-Agent': S.USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          'Accept-Encoding': 'identity',
        },
        // Connect to the address that was checked, never to a fresh resolution of the name.
        lookup: (hostname, options, callback) => {
          if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
          else callback(null, pinned.address, pinned.family);
        },
        agent: false,
      },
      resolve,
    );
    request.on('error', reject);
    request.end();
  });
}

/** The body, stopping at maxBytes. */
function readBody(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy();
        reject(new WebFetchError(E.TOO_LARGE));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
}

/**
 * @param {string} rawUrl
 * @param {{ checkHost: (hostname: string) => void, allowedRanges?: import('node:net').BlockList,
 *   allowedPorts?: number[], resolve?: typeof dnsLookup, timeoutMs?: number, maxBytes?: number,
 *   maxRedirects?: number }} options
 *   `checkHost` throws a WebFetchError for a host the admin's lists refuse
 */
export async function fetchPublicPage(
  rawUrl,
  {
    checkHost,
    allowedRanges,
    allowedPorts = S.ALLOWED_PORTS,
    resolve = dnsLookup,
    timeoutMs = S.FETCH_TIMEOUT_MS,
    maxBytes = S.FETCH_MAX_BYTES,
    maxRedirects = S.MAX_REDIRECTS,
  },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const first = normalizeUrl(rawUrl, { allowedPorts });
  let current = first;
  try {
    for (let redirects = 0; ; redirects += 1) {
      checkHost(current.hostname);
      const [pinned] = await resolvePublicAddresses(current.hostname, {
        resolve,
        allowedRanges,
        signal: controller.signal,
      });
      let response;
      try {
        response = await requestOnce(new URL(current.url), pinned, controller.signal);
      } catch (requestError) {
        if (controller.signal.aborted) throw new WebFetchError(E.TIMEOUT);
        throw new WebFetchError(E.NETWORK_ERROR, { cause: requestError.code ?? requestError.name });
      }
      const status = response.statusCode;
      if (REDIRECT_STATUSES.has(status) && response.headers.location) {
        response.resume();
        if (redirects >= maxRedirects) throw new WebFetchError(E.TOO_MANY_REDIRECTS);
        let next;
        try {
          next = new URL(response.headers.location, current.url).toString();
        } catch {
          throw new WebFetchError(E.INVALID_URL);
        }
        current = normalizeUrl(next, { allowedPorts });
        continue;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        throw new WebFetchError(E.HTTP_ERROR, { status });
      }
      const contentType = (response.headers['content-type'] ?? '').toLowerCase();
      const mediaType = contentType.split(';')[0].trim();
      if (!S.CONTENT_TYPES.includes(mediaType)) {
        response.resume();
        throw new WebFetchError(E.UNSUPPORTED_CONTENT);
      }
      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        throw new WebFetchError(E.TOO_LARGE);
      }
      let body;
      try {
        body = await readBody(response, maxBytes);
      } catch (readError) {
        if (readError instanceof WebFetchError) throw readError;
        if (controller.signal.aborted) throw new WebFetchError(E.TIMEOUT);
        throw new WebFetchError(E.NETWORK_ERROR);
      }
      return {
        url: first.url,
        finalUrl: current.url,
        hostname: current.hostname,
        contentType: mediaType,
        text: decode(body, contentType),
        sizeBytes: body.length,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
