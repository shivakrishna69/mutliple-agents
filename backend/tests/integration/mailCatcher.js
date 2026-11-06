/**
 * A mail server for tests: accepts every message the backend sends over SMTP and keeps it in memory,
 * so a test can read an emailed link and use it through the API, as a person would.
 *
 * Test-only. It lives under tests/, which the production image never contains (backend/.dockerignore
 * is an allowlist, and CI checks the built image).
 *
 * Plain SMTP on 127.0.0.1 without TLS or authentication; the backend accepts that only outside
 * production (SMTP_REQUIRE_TLS=false). With `httpPort`, it also answers GET /messages?to=<address>
 * with the messages for that address as JSON, so browser tests in other processes can read them.
 */

import http from 'node:http';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';

const DEFAULT_WAIT_MS = 10_000;
/** A sender hanging up mid-conversation: expected when a test server stops, not a test failure. */
const CLIENT_DISCONNECT_CODES = new Set(['ECONNRESET', 'EPIPE']);

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

/**
 * @param {{ httpPort?: number }} [options]
 * @returns {Promise<{ smtpPort: number, httpUrl: string|null, messagesTo: (address: string) => object[],
 *   waitForMessages: (address: string, count?: number, timeoutMs?: number) => Promise<object[]>,
 *   close: () => Promise<void> }>}
 */
export async function startMailCatcher({ httpPort } = {}) {
  /** @type {{ to: string[], from: string, subject: string, text: string, html: string }[]} */
  const messages = [];
  const listeners = new Set();

  const smtpServer = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, _session, callback) {
      simpleParser(stream)
        .then((parsed) => {
          messages.push({
            to: (parsed.to?.value ?? []).map((recipient) => recipient.address.toLowerCase()),
            from: parsed.from?.text ?? '',
            subject: parsed.subject ?? '',
            text: parsed.text ?? '',
            html: typeof parsed.html === 'string' ? parsed.html : '',
          });
          for (const notify of listeners) notify();
          callback();
        })
        .catch(callback);
    },
  });
  // The backend's pooled mail connections may be cut when a test server stops. smtp-server reports
  // that as an 'error' event, which with no listener would crash the test run after every test passed.
  smtpServer.on('error', (connectionError) => {
    if (CLIENT_DISCONNECT_CODES.has(connectionError.code)) return;
    console.error('Test mail inbox error:', connectionError);
  });
  const smtpPort = await listen(smtpServer.server, 0);

  const messagesTo = (address) => messages.filter((message) => message.to.includes(address.toLowerCase()));

  /** Resolves with every message to `address` once there are at least `count` of them. */
  function waitForMessages(address, count = 1, timeoutMs = DEFAULT_WAIT_MS) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const received = messagesTo(address);
        if (received.length < count) return false;
        listeners.delete(check);
        clearTimeout(timer);
        resolve(received);
        return true;
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(
          new Error(
            `Expected ${count} email(s) to ${address} within ${timeoutMs} ms; got ${messagesTo(address).length}`,
          ),
        );
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  }

  let httpServer = null;
  let httpUrl = null;
  if (httpPort !== undefined) {
    httpServer = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || requestUrl.pathname !== '/messages') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messagesTo(requestUrl.searchParams.get('to') ?? '')));
    });
    httpUrl = `http://127.0.0.1:${await listen(httpServer, httpPort)}`;
  }

  async function close() {
    await new Promise((resolve) => smtpServer.close(resolve));
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  }

  return { smtpPort, httpUrl, messagesTo, waitForMessages, close };
}

/**
 * The token at the end of the first `${pathPrefix}/<token>` link in a message's text.
 * @param {{ text: string }} message
 * @param {string} pathPrefix  e.g. '/verify-email'
 */
export function tokenFromEmail(message, pathPrefix) {
  const escapedPrefix = pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = message.text.match(new RegExp(`${escapedPrefix}/([A-Za-z0-9_-]+)`));
  if (!match) throw new Error(`No ${pathPrefix} link in the email "${message.subject}"`);
  return match[1];
}

/**
 * The emailed code (confirmation or password reset): the `digits`-digit number ending a line of the
 * text ("...: 123456"), which the subject also leads with.
 * @param {{ text: string, subject: string }} message
 * @param {number} digits
 */
export function codeFromEmail(message, digits) {
  const code = message.text.match(new RegExp(`: (\\d{${digits}})$`, 'm'))?.[1];
  if (!code || !message.subject.startsWith(code)) throw new Error(`No code in the email "${message.subject}"`);
  return code;
}
