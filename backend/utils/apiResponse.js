/**
 * Builders for the two JSON response shapes the backend returns.
 *
 *   Success: { "message": string, "data": object }
 *   Error:   { "error": { "message": string, "requestId": string, "details"?: array } }
 *
 * The error shape is the same one the central error handler in server.js produces, and the
 * same one the ai-service returns, so clients parse every failure the same way regardless of
 * which layer rejected the request. `requestId` matches the X-Request-Id response header and
 * the server logs, so a user-reported failure can be traced to its log lines.
 */

/**
 * Sends a success response.
 * @param {import('express').Response} res
 * @param {number} statusCode  2xx status from HTTP_STATUS.
 * @param {string} message     Message from constants/messages.js.
 * @param {object} responsePayload  Returned to the client under `data`.
 */
export function sendSuccess(res, statusCode, message, responsePayload) {
  return res.status(statusCode).json({ message, data: responsePayload });
}

/**
 * Sends an expected-error response (bad input, failed authentication). Unexpected errors
 * are not sent with this; they are passed to `next(error)` so the central error handler
 * logs the stack trace and hides internals in production.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} statusCode  4xx status from HTTP_STATUS.
 * @param {string} message     Message from constants/messages.js.
 * @param {Array<{field: string, message: string}>} [errorDetails]  Per-field validation failures.
 */
export function sendError(req, res, statusCode, message, errorDetails) {
  return res.status(statusCode).json({
    error: {
      message,
      requestId: req.id,
      ...(errorDetails && errorDetails.length > 0 && { details: errorDetails }),
    },
  });
}
