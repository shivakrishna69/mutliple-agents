/**
 * What the page fetcher (safeFetch.js) may reach. Every rule here is checked before a connection is
 * made, and again for every redirect:
 *
 *   normalizeUrl(raw, ports) http or https only; no user name or password; a host; the allowed ports
 *                            only (WEB_FETCH_ALLOWED_PORTS, default 80 and 443); at most URL_MAX_LENGTH; the
 *                            #fragment dropped and the host lower-cased, so one page has one address
 *   domainPolicyOf(host, s)  the admin's lists (WebResearchSettings): a blocked domain is never read;
 *                            an allowed one is "approved" (its pages are cached for everyone); any
 *                            other is "unlisted" (read for people with live research, cached for them
 *                            only) unless the admin turned unlisted domains off. A domain entry covers
 *                            its subdomains: "rbi.org.in" covers "www.rbi.org.in"; an IP address entry
 *                            covers that address only.
 *   isPublicAddress(ip)      false for every address that is not on the public internet: private,
 *                            loopback, link-local (cloud metadata), carrier-grade NAT, documentation,
 *                            benchmarking, multicast, reserved, and IPv6 unique-local, link-local,
 *                            and the forms that embed an IPv4 address (mapped, NAT64, 6to4, Teredo),
 *                            which are judged by that address. A deployment may let some private
 *                            ranges through (WEB_FETCH_ALLOWED_PRIVATE_CIDRS).
 */

import { BlockList, isIP } from 'node:net';
import { WEB_RESEARCH_SETTINGS as S } from '../../constants/validation.js';

export class WebFetchError extends Error {
  /** @param {string} code  a key of WEB_RESEARCH_MESSAGES.FETCH_REFUSED */
  constructor(code, details = {}) {
    super(code);
    this.name = 'WebFetchError';
    this.code = code;
    this.details = details;
  }
}

export const FETCH_ERROR_CODES = Object.freeze({
  INVALID_URL: 'INVALID_URL',
  SCHEME_NOT_ALLOWED: 'SCHEME_NOT_ALLOWED',
  PORT_NOT_ALLOWED: 'PORT_NOT_ALLOWED',
  CREDENTIALS_NOT_ALLOWED: 'CREDENTIALS_NOT_ALLOWED',
  DOMAIN_BLOCKED: 'DOMAIN_BLOCKED',
  DOMAIN_NOT_ALLOWED: 'DOMAIN_NOT_ALLOWED',
  PRIVATE_ADDRESS: 'PRIVATE_ADDRESS',
  DNS_FAILED: 'DNS_FAILED',
  TOO_MANY_REDIRECTS: 'TOO_MANY_REDIRECTS',
  TIMEOUT: 'TIMEOUT',
  TOO_LARGE: 'TOO_LARGE',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  HTTP_ERROR: 'HTTP_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  EMPTY_CONTENT: 'EMPTY_CONTENT',
});

const E = FETCH_ERROR_CODES;

export const DOMAIN_POLICIES = Object.freeze({
  APPROVED: 'approved',
  UNLISTED: 'unlisted',
  BLOCKED: 'blocked',
  NOT_ALLOWED: 'not_allowed',
});

// Not on the public internet (IANA special-purpose registries).
const NON_PUBLIC_IPV4 = Object.freeze([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]);
const NON_PUBLIC_IPV6 = Object.freeze([
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]);

const nonPublic = new BlockList();
for (const [address, prefix] of NON_PUBLIC_IPV4) nonPublic.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of NON_PUBLIC_IPV6) nonPublic.addSubnet(address, prefix, 'ipv6');

/** A BlockList of the CIDR ranges a deployment lets through (config.webResearch.allowedPrivateCidrs). */
export function allowedRangesOf(cidrs = []) {
  const ranges = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split('/');
    ranges.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
  }
  return ranges;
}

/** The sixteen bytes of an IPv6 address (with "::" expanded and a dotted IPv4 tail read). */
function ipv6Bytes(address) {
  let text = address.toLowerCase().split('%')[0];
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const parts = tail[1].split('.').map(Number);
    text = `${text.slice(0, -tail[1].length)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const headGroups = head ? head.split(':') : [];
  const restGroups = rest === undefined ? [] : rest ? rest.split(':') : [];
  const missing = 8 - headGroups.length - restGroups.length;
  const groups = rest === undefined ? headGroups : [...headGroups, ...Array(missing).fill('0'), ...restGroups];
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

const ipv4Of = (bytes) => bytes.join('.');

/** The IPv4 address an IPv6 address carries (mapped, NAT64, 6to4, Teredo), or null. */
export function embeddedIpv4(address) {
  const bytes = ipv6Bytes(address);
  const isZero = (from, to) => bytes.slice(from, to).every((byte) => byte === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated)
  if (isZero(0, 10) && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))) {
    return isZero(0, 16) || (isZero(0, 15) && bytes[15] === 1) ? null : ipv4Of(bytes.slice(12));
  }
  // 64:ff9b::/96 (NAT64)
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && isZero(4, 12)) {
    return ipv4Of(bytes.slice(12));
  }
  // 2002::/16 (6to4): the IPv4 address is bytes 2-5
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return ipv4Of(bytes.slice(2, 6));
  // 2001:0::/32 (Teredo): the client's IPv4 address, inverted, is the last four bytes
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
    return ipv4Of(bytes.slice(12).map((byte) => byte ^ 0xff));
  }
  return null;
}

/**
 * True when `address` is on the public internet, or in a range the deployment lets through.
 * @param {string} address  an IPv4 or IPv6 address
 * @param {BlockList} [allowedRanges]
 */
export function isPublicAddress(address, allowedRanges = new BlockList()) {
  const family = isIP(address);
  if (family === 0) return false;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (allowedRanges.check(address, type)) return true;
  if (family === 6) {
    const carried = embeddedIpv4(address);
    if (carried !== null) return isPublicAddress(carried, allowedRanges);
  }
  return !nonPublic.check(address, type);
}

/**
 * A URL the fetcher may request, normalised.
 * @returns {{ url: string, hostname: string }}
 * @throws {WebFetchError}
 */
export function normalizeUrl(raw, { allowedPorts = S.ALLOWED_PORTS } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > S.URL_MAX_LENGTH) {
    throw new WebFetchError(E.INVALID_URL);
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new WebFetchError(E.INVALID_URL);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new WebFetchError(E.SCHEME_NOT_ALLOWED);
  if (parsed.username || parsed.password) throw new WebFetchError(E.CREDENTIALS_NOT_ALLOWED);
  if (!parsed.hostname) throw new WebFetchError(E.INVALID_URL);
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (!allowedPorts.includes(port)) throw new WebFetchError(E.PORT_NOT_ALLOWED);
  parsed.hash = '';
  // URL already lower-cases the host and turns international names into punycode.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(hostname) !== 6) parsed.hostname = hostname;
  return { url: parsed.toString(), hostname };
}

/** "Www.RBI.org.in." → "www.rbi.org.in", an IP address as it is; null for anything else. */
export function normalizeDomain(raw) {
  if (typeof raw !== 'string') return null;
  const domain = raw.trim().toLowerCase().replace(/\.$/, '');
  if (isIP(domain)) return domain;
  if (!domain || domain.length > S.DOMAIN_MAX_LENGTH) return null;
  const labels = domain.split('.');
  const isLabel = (label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label);
  return labels.length >= 2 && labels.every(isLabel) ? domain : null;
}

/** True when `hostname` is `domain` or one of its subdomains (an IP address entry: that address only). */
export function hostIsWithin(hostname, domain) {
  if (isIP(domain)) return hostname === domain;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * @param {string} hostname
 * @param {{ allowedDomains: string[], blockedDomains: string[], allowUnlistedDomains: boolean }} settings
 */
export function domainPolicyOf(hostname, settings) {
  if (settings.blockedDomains.some((domain) => hostIsWithin(hostname, domain))) return DOMAIN_POLICIES.BLOCKED;
  if (settings.allowedDomains.some((domain) => hostIsWithin(hostname, domain))) return DOMAIN_POLICIES.APPROVED;
  return settings.allowUnlistedDomains ? DOMAIN_POLICIES.UNLISTED : DOMAIN_POLICIES.NOT_ALLOWED;
}

/** Throws for a host the admin blocked or did not allow; otherwise its policy. */
export function assertDomainAllowed(hostname, settings) {
  const policy = domainPolicyOf(hostname, settings);
  if (policy === DOMAIN_POLICIES.BLOCKED) throw new WebFetchError(E.DOMAIN_BLOCKED);
  if (policy === DOMAIN_POLICIES.NOT_ALLOWED) throw new WebFetchError(E.DOMAIN_NOT_ALLOWED);
  return policy;
}
