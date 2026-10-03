/**
 * Structured JSON logger shared by every backend module.
 *
 * Every log line is one JSON object (`ts`, `level`, `service`, `msg`, plus context fields),
 * so log collectors can parse and filter it without regexes. `warn` and `error` go to
 * stderr, everything else to stdout. The minimum level comes from LOG_LEVEL
 * (debug | info | warn | error, default info).
 *
 * This lives in its own module rather than in server.js because importing server.js
 * starts the HTTP server; controllers and middleware import the logger from here.
 */

const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const activeLogLevel = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

/**
 * Writes one JSON log line. `context` is merged into the line, so callers pass
 * identifiers (requestId, userId) as fields instead of interpolating them into `msg`.
 */
export function log(level, msg, context = {}) {
  if (LOG_LEVELS[level] < activeLogLevel) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: 'backend', msg, ...context });
  (LOG_LEVELS[level] >= LOG_LEVELS.warn ? process.stderr : process.stdout).write(line + '\n');
}

export const logger = Object.freeze({
  debug: (msg, context) => log('debug', msg, context),
  info: (msg, context) => log('info', msg, context),
  warn: (msg, context) => log('warn', msg, context),
  error: (msg, context) => log('error', msg, context),
});
