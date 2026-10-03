/**
 * Session cookies: writing, clearing, and reading them without a cookie-parser dependency.
 *
 * Two cookies are set on signup and login, with identical attributes and lifetime:
 *   access_token  the session JWT.
 *   csrf_token    the CSRF token paired with that JWT. The frontend does not read this cookie;
 *                 it receives the token in the JSON body of signup, login, and GET /me, and
 *                 GET /me reads it from this cookie so the token survives a page reload.
 *
 * Attributes and why:
 *   HttpOnly         JavaScript cannot read either cookie, so an XSS bug cannot steal the session.
 *   SameSite=Strict  The browser does not attach them to requests started by another site, the
 *                    first line of defence against CSRF (the CSRF token is the second).
 *   Secure           Sent over HTTPS only (config.cookieSecure: on in production, enforced at startup).
 *   Path=/           Required by the __Host- prefix and covers every API route.
 *   Max-Age          Equal to the JWT's remaining lifetime, so the cookie and token expire together.
 *   __Host- prefix   Added whenever Secure is on. Browsers then reject the cookie unless it is
 *                    Secure, has Path=/ and no Domain, which stops a compromised subdomain from
 *                    planting or overwriting it.
 */

const AUTH_COOKIE_BASE_NAMES = Object.freeze({
  ACCESS_TOKEN: 'access_token',
  CSRF_TOKEN: 'csrf_token',
});

/** Cookie name for the current security mode: `__Host-` prefixed when Secure is on. */
function resolveCookieName(baseCookieName, cookieConfig) {
  return cookieConfig.cookieSecure ? `__Host-${baseCookieName}` : baseCookieName;
}

export function resolveAccessTokenCookieName(cookieConfig) {
  return resolveCookieName(AUTH_COOKIE_BASE_NAMES.ACCESS_TOKEN, cookieConfig);
}

export function resolveCsrfTokenCookieName(cookieConfig) {
  return resolveCookieName(AUTH_COOKIE_BASE_NAMES.CSRF_TOKEN, cookieConfig);
}

/** Attributes shared by both cookies when setting and clearing them. */
function buildBaseCookieOptions(cookieConfig) {
  return {
    httpOnly: true,
    secure: cookieConfig.cookieSecure,
    sameSite: 'strict',
    path: '/',
  };
}

/**
 * Writes both session cookies.
 * @param {import('express').Response} res
 * @param {{ cookieSecure: boolean }} cookieConfig
 * @param {{ accessToken: string, csrfToken: string, expiresAtMs: number }} sessionTokens
 */
export function setSessionCookies(res, cookieConfig, { accessToken, csrfToken, expiresAtMs }) {
  const cookieOptions = { ...buildBaseCookieOptions(cookieConfig), maxAge: Math.max(0, expiresAtMs - Date.now()) };
  res.cookie(resolveAccessTokenCookieName(cookieConfig), accessToken, cookieOptions);
  res.cookie(resolveCsrfTokenCookieName(cookieConfig), csrfToken, cookieOptions);
}

/** Tells the browser to delete both session cookies (attributes must match how they were set). */
export function clearSessionCookies(res, cookieConfig) {
  const cookieOptions = buildBaseCookieOptions(cookieConfig);
  res.clearCookie(resolveAccessTokenCookieName(cookieConfig), cookieOptions);
  res.clearCookie(resolveCsrfTokenCookieName(cookieConfig), cookieOptions);
}

/** Returns the value of one cookie from an Express request, or null. See `readCookieFromHeader`. */
export function readRequestCookie(req, cookieName) {
  return readCookieFromHeader(req.get('cookie'), cookieName);
}

/**
 * Returns the value of one cookie from a raw Cookie header string, or null. Used directly for
 * Socket.IO handshakes, whose request object is a plain Node IncomingMessage.
 *
 * Parsing rules (RFC 6265 §5.4): pairs are separated by ";", the name ends at the first "=",
 * surrounding whitespace is ignored, and a value wrapped in double quotes is unwrapped. When a
 * name appears more than once the first occurrence wins, matching how browsers order cookies
 * (most specific path first). Values that are not valid percent-encoding are treated as absent.
 */
export function readCookieFromHeader(cookieHeader, cookieName) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null;

  for (const cookiePair of cookieHeader.split(';')) {
    const separatorIndex = cookiePair.indexOf('=');
    if (separatorIndex === -1) continue;
    if (cookiePair.slice(0, separatorIndex).trim() !== cookieName) continue;

    let cookieValue = cookiePair.slice(separatorIndex + 1).trim();
    if (cookieValue.length >= 2 && cookieValue.startsWith('"') && cookieValue.endsWith('"')) {
      cookieValue = cookieValue.slice(1, -1);
    }
    try {
      return decodeURIComponent(cookieValue);
    } catch {
      return null;
    }
  }
  return null;
}
