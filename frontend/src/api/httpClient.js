/**
 * Shared HTTP client for the backend API, used by every api/* module.
 *
 * Session transport: the backend keeps the session JWT in HttpOnly cookies that this code
 * cannot read. Requests are sent with `credentials: 'include'` so the browser attaches them.
 * State-changing requests on an existing session pass the in-memory CSRF token, which is sent
 * in the X-CSRF-Token header.
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
 *
 * If the caller's AbortSignal fires (for example, the page unmounted), the original
 * AbortError is rethrown so the caller can recognise it and ignore it.
 */

import { API_MESSAGES } from '../constants/messages.js';

/** Empty means "same origin": in development the Vite proxy forwards /api to the backend. */
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

/** Upper bound for one request. Signup and login include a deliberate ~250 ms bcrypt hash. */
const REQUEST_TIMEOUT_MS = 15_000;

export const HTTP_STATUS_UNAUTHORIZED = 401;

/** A failed API call, carrying only information that is safe to display. */
export class ApiError extends Error {
  /**
   * @param {object} errorProperties
   * @param {string} errorProperties.message       User-facing message.
   * @param {number} errorProperties.status        HTTP status, or 0 if no response arrived.
   * @param {string|null} [errorProperties.requestId]  Backend request id, shown for server faults.
   * @param {Record<string, string>} [errorProperties.fieldErrors]  Message per form field.
   * @param {string|null} [errorProperties.code]     Backend machine-readable code (e.g. STALE_VERSION).
   * @param {object|null} [errorProperties.context]  Backend details that go with the code.
   */
  constructor({ message, status, requestId = null, fieldErrors = {}, code = null, context = null }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.requestId = requestId;
    this.fieldErrors = fieldErrors;
    this.code = code;
    this.context = context;
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
 * @param {'GET'|'POST'|'PATCH'} requestDescription.method
 * @param {string} requestDescription.endpointPath
 * @param {object} [requestDescription.requestPayload]  JSON body, for POST/PATCH.
 * @param {FormData} [requestDescription.formData]      Multipart body (file uploads); the browser sets
 *                                                      the Content-Type with its boundary.
 * @param {string} [requestDescription.csrfToken]       Sent as X-CSRF-Token when provided.
 * @param {AbortSignal} [requestDescription.callerSignal]
 */
export async function sendApiRequest({ method, endpointPath, requestPayload, formData, csrfToken, callerSignal }) {
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
      body: formData ?? (requestPayload === undefined ? undefined : JSON.stringify(requestPayload)),
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
      code: typeof backendError?.code === 'string' ? backendError.code : null,
      context: backendError?.context && typeof backendError.context === 'object' ? backendError.context : null,
    });
  }

  return { responseData: responseBody?.data, httpStatus: httpResponse.status };
}

