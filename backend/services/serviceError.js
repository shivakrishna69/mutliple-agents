/**
 * An error a service throws for a situation the client can act on: not found, conflict, stale
 * version, not allowed. `httpStatus` and the stable `code` go into the API response; anything
 * else a service throws is unexpected and reaches the central error handler as a 500.
 *
 * Used by the HR features built on controllers/workforceHandler.js (work calendar, offices).
 */
export class ServiceError extends Error {
  constructor(httpStatus, code, message) {
    super(message);
    this.name = 'ServiceError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}
