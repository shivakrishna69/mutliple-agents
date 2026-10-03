/**
 * HTTP client for the backend's auth endpoints.
 *
 * Session transport: the backend keeps the session JWT in HttpOnly cookies that this code
 * cannot read. Requests are sent with `credentials: 'include'` so the browser attaches them.
 * State-changing requests on an existing session (logout, and future protected POSTs) also
 * send the in-memory CSRF token in the X-CSRF-Token header.
 *
 * Every failure is converted into an `ApiError` with a message that is safe to show
 * the user, so pages never parse raw responses or show stack traces:
 *
 *   network down / DNS / CORS failure -> status 0,   NETWORK_UNAVAILABLE
 *   no response within the timeout   -> status 0,   REQUEST_TIMED_OUT
 *   4xx with the backend error shape  -> that status, the backend's message, plus per-field
 *                                        errors from `error.details`
 *   5xx                               -> that status, a generic message (server internals are
 *                                        never shown) and the requestId for support
 *   2xx without the expected data     -> UNEXPECTED_RESPONSE
 *
 * If the caller's AbortSignal fires (for example, the page unmounted), the original
 * AbortError is rethrown so the caller can recognise it and ignore it.
 */

import { API_MESSAGES } from '../constants/messages.js';

/** Empty means "same origin": in development the Vite proxy forwards /api to the backend. */
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

/** Upper bound for one request. Signup and login include a deliberate ~250 ms bcrypt hash. */
const REQUEST_TIMEOUT_MS = 15_000;

const HTTP_STATUS_UNAUTHORIZED = 401;

export const AUTH_ENDPOINTS = Object.freeze({
  SIGNUP: '/api/auth/signup',
  LOGIN: '/api/auth/login',
  CURRENT_SESSION: '/api/auth/me',
  LOGOUT: '/api/auth/logout',
});

/** A failed API call, carrying only information that is safe to display. */
export class ApiError extends Error {
  /**
   * @param {object} errorProperties
   * @param {string} errorProperties.message       User-facing message.
   * @param {number} errorProperties.status        HTTP status, or 0 if no response arrived.
   * @param {string|null} [errorProperties.requestId]  Backend request id, shown for server faults.
   * @param {Record<string, string>} [errorProperties.fieldErrors]  Message per form field.
   */
  constructor({ message, status, requestId = null, fieldErrors = {} }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.requestId = requestId;
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Converts the backend's `details: [{ field, message }]` list into `{ field: message }`,
 * keeping the first message per field. The "body" pseudo-field is dropped because it does
 * not correspond to an input the user can fix.
 */
function convertDetailsToFieldErrors(errorDetails) {
  if (!Array.isArray(errorDetails)) return {};
  const fieldErrors = {};
  for (const fieldIssue of errorDetails) {
    const isUsableIssue = typeof fieldIssue?.field === 'string' && typeof fieldIssue?.message === 'string';
    if (isUsableIssue && fieldIssue.field !== 'body' && !(fieldIssue.field in fieldErrors)) {
      fieldErrors[fieldIssue.field] = fieldIssue.message;
    }
  }
  return fieldErrors;
}

/**
 * Sends one request to the backend and returns `{ responseData, httpStatus }` on 2xx,
 * where `responseData` is the response's `data` object.
 * @param {object} requestDescription
 * @param {'GET'|'POST'} requestDescription.method
 * @param {string} requestDescription.endpointPath
 * @param {object} [requestDescription.requestPayload]  JSON body, for POST.
 * @param {string} [requestDescription.csrfToken]       Sent as X-CSRF-Token when provided.
 * @param {AbortSignal} [requestDescription.callerSignal]
 */
async function sendApiRequest({ method, endpointPath, requestPayload, csrfToken, callerSignal }) {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

  const requestHeaders = { Accept: 'application/json' };
  if (requestPayload !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (csrfToken) requestHeaders['X-CSRF-Token'] = csrfToken;

  let httpResponse;
  try {
    httpResponse = await fetch(`${API_BASE_URL}${endpointPath}`, {
      method,
      headers: requestHeaders,
      body: requestPayload === undefined ? undefined : JSON.stringify(requestPayload),
      credentials: 'include',
      signal: requestSignal,
    });
  } catch (transportError) {
    if (callerSignal?.aborted) throw transportError;
    if (timeoutSignal.aborted) throw new ApiError({ message: API_MESSAGES.REQUEST_TIMED_OUT, status: 0 });
    throw new ApiError({ message: API_MESSAGES.NETWORK_UNAVAILABLE, status: 0 });
  }

  // A body that is not JSON (an HTML proxy error page, an empty 502) is treated as absent.
  let responseBody = null;
  try {
    responseBody = await httpResponse.json();
  } catch (bodyParseError) {
    if (callerSignal?.aborted) throw bodyParseError;
    responseBody = null;
  }

  if (!httpResponse.ok) {
    const backendError = responseBody?.error;
    const requestId = backendError?.requestId ?? httpResponse.headers.get('X-Request-Id');

    if (httpResponse.status >= 500) {
      // No backend error body means the response came from something in front of the API
      // (the dev proxy or a load balancer) because the backend itself did not answer.
      throw new ApiError({
        message: backendError ? API_MESSAGES.UNEXPECTED_SERVER_ERROR : API_MESSAGES.SERVER_UNAVAILABLE,
        status: httpResponse.status,
        requestId,
      });
    }

    throw new ApiError({
      message: typeof backendError?.message === 'string' ? backendError.message : API_MESSAGES.UNEXPECTED_RESPONSE,
      status: httpResponse.status,
      requestId,
      fieldErrors: convertDetailsToFieldErrors(backendError?.details),
    });
  }

  return { responseData: responseBody?.data, httpStatus: httpResponse.status };
}

/**
 * Checks that a session response carries `{ user, csrfToken }` and returns exactly those.
 * Anything else means the backend and frontend disagree on the contract.
 */
function extractSessionPayload({ responseData, httpStatus }) {
  const hasUser = typeof responseData?.user === 'object' && responseData.user !== null;
  const hasCsrfToken = typeof responseData?.csrfToken === 'string' && responseData.csrfToken.length > 0;
  if (!hasUser || !hasCsrfToken) {
    throw new ApiError({ message: API_MESSAGES.UNEXPECTED_RESPONSE, status: httpStatus });
  }
  return { user: responseData.user, csrfToken: responseData.csrfToken };
}

/**
 * Creates an account and signs in. Resolves to `{ user, csrfToken }`; the session cookies are
 * set by the response.
 * @param {{ name: string, email: string, password: string }} signupDetails
 * @param {{ signal?: AbortSignal }} [requestOptions]
 */
export async function requestSignup(signupDetails, { signal } = {}) {
  const apiResponse = await sendApiRequest({
    method: 'POST',
    endpointPath: AUTH_ENDPOINTS.SIGNUP,
    requestPayload: signupDetails,
    callerSignal: signal,
  });
  return extractSessionPayload(apiResponse);
}

/**
 * Exchanges credentials for a session. Resolves to `{ user, csrfToken }`.
 * @param {{ email: string, password: string }} loginCredentials
 * @param {{ signal?: AbortSignal }} [requestOptions]
 */
export async function requestLogin(loginCredentials, { signal } = {}) {
  const apiResponse = await sendApiRequest({
    method: 'POST',
    endpointPath: AUTH_ENDPOINTS.LOGIN,
    requestPayload: loginCredentials,
    callerSignal: signal,
  });
  return extractSessionPayload(apiResponse);
}

/**
 * Asks the backend whether the browser holds a valid session (used on page load).
 * Resolves to `{ user, csrfToken }`, or to null when there is no valid session (401).
 * Other failures (network, 5xx) reject with ApiError so the caller can tell them apart from
 * "signed out".
 * @param {{ signal?: AbortSignal }} [requestOptions]
 */
export async function requestCurrentSession({ signal } = {}) {
  try {
    const apiResponse = await sendApiRequest({
      method: 'GET',
      endpointPath: AUTH_ENDPOINTS.CURRENT_SESSION,
      callerSignal: signal,
    });
    return extractSessionPayload(apiResponse);
  } catch (sessionError) {
    if (sessionError instanceof ApiError && sessionError.status === HTTP_STATUS_UNAUTHORIZED) return null;
    throw sessionError;
  }
}

/**
 * Ends the session on the server (revokes it) and clears the cookies.
 * Resolves when the server confirms. A 401 also resolves, because it means the session had
 * already ended, which is the outcome the caller wanted.
 * @param {string} csrfToken  The current session's CSRF token.
 */
export async function requestLogout(csrfToken) {
  try {
    await sendApiRequest({
      method: 'POST',
      endpointPath: AUTH_ENDPOINTS.LOGOUT,
      requestPayload: {},
      csrfToken,
    });
  } catch (logoutError) {
    if (logoutError instanceof ApiError && logoutError.status === HTTP_STATUS_UNAUTHORIZED) return;
    throw logoutError;
  }
}
