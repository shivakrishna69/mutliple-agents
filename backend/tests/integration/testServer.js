/**
 * Integration-test harness: runs the real server.js as a child process against a throwaway MongoDB
 * database, and offers an HTTP client that keeps session cookies and the CSRF token like a browser.
 *
 * Isolation:
 *   - Each call to startTestServer() gets its own free port and a randomly named database, which is
 *     dropped on stop(); test files can therefore run in parallel.
 *   - The server starts in an empty temporary directory with a minimal environment, so a developer's
 *     backend/.env (SMTP, S3, Redis, real secrets) never leaks into a test run.
 *
 * MongoDB: TEST_MONGO_URL (default mongodb://127.0.0.1:27017). When it cannot be reached the
 * integration tests are skipped locally, but fail in CI (CI=true) so a broken setup is never green.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const SERVER_ENTRY_PATH = fileURLToPath(new URL('../../server.js', import.meta.url));
const MONGO_BASE_URL = (process.env.TEST_MONGO_URL ?? 'mongodb://127.0.0.1:27017').replace(/\/+$/, '');
const STARTUP_TIMEOUT_MS = 30_000;

export const TEST_APP_ORIGIN = 'http://localhost:5173';
export const TEST_ADMIN_EMAIL = 'admin@example.com';
export const STRONG_PASSWORD = 'Valid#Pass2026';

/** Host variables the child needs to run at all; nothing application-specific is inherited. */
const INHERITED_ENVIRONMENT_KEYS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'];

/** Resolves to a skip reason when MongoDB is unreachable outside CI, otherwise null. */
export async function mongoUnavailableReason() {
  const probeConnection = mongoose.createConnection(`${MONGO_BASE_URL}/admin`, { serverSelectionTimeoutMS: 2_000 });
  try {
    await probeConnection.asPromise();
    return null;
  } catch (connectionError) {
    if (process.env.CI === 'true') throw connectionError;
    return `MongoDB is not reachable at ${MONGO_BASE_URL} (start it or set TEST_MONGO_URL)`;
  } finally {
    await probeConnection.close().catch(() => {});
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probeServer = createServer();
    probeServer.once('error', reject);
    probeServer.listen(0, '127.0.0.1', () => {
      const { port } = probeServer.address();
      probeServer.close(() => resolve(port));
    });
  });
}

function buildServerEnvironment({ port, mongoUri, appOrigin }) {
  const inherited = Object.fromEntries(
    INHERITED_ENVIRONMENT_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
  return {
    ...inherited,
    NODE_ENV: 'development',
    LOG_LEVEL: 'error',
    PORT: String(port),
    MONGO_URI: mongoUri,
    JWT_SECRET: randomBytes(32).toString('hex'),
    WEBHOOK_SIGNING_SECRET: randomBytes(32).toString('hex'),
    AI_SERVICE_API_KEY: randomBytes(32).toString('hex'),
    // Nothing listens here; tests never reach the AI service.
    AI_SERVICE_URL: 'http://127.0.0.1:9',
    CORS_ORIGINS: appOrigin,
    BOOTSTRAP_ADMIN_EMAIL: TEST_ADMIN_EMAIL,
    COMPANY_NAME: 'Test Company',
  };
}

async function waitUntilHealthy(baseUrl, serverProcess, readOutput) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Test server exited with code ${serverProcess.exitCode}:\n${readOutput()}`);
    }
    try {
      const healthResponse = await fetch(`${baseUrl}/api/health`);
      if (healthResponse.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Test server was not healthy within ${STARTUP_TIMEOUT_MS} ms:\n${readOutput()}`);
}

/**
 * Starts server.js on a fresh database.
 * @param {{ port?: number, appOrigin?: string, seedBeforeStart?: (database: mongoose.Connection) => Promise<void> }} [options]
 *   A fixed port and the browser origin to allow (the frontend's browser tests need both to be known
 *   in advance); by default a free port and TEST_APP_ORIGIN. `seedBeforeStart` writes data before the
 *   server starts, so its startup migrations see that data.
 * @returns {Promise<{ baseUrl: string, database: mongoose.Connection, createClient: () => TestClient, stop: () => Promise<void> }>}
 */
export async function startTestServer({ port: requestedPort, appOrigin = TEST_APP_ORIGIN, seedBeforeStart } = {}) {
  const port = requestedPort ?? (await findFreePort());
  const databaseName = `unitora_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  const mongoUri = `${MONGO_BASE_URL}/${databaseName}`;
  const workingDirectory = await mkdtemp(path.join(tmpdir(), 'unitora-backend-test-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const database = mongoose.createConnection(mongoUri, { serverSelectionTimeoutMS: 5_000 });
  let serverProcess = null;
  let capturedOutput = '';

  function spawnServer() {
    serverProcess = spawn(process.execPath, [SERVER_ENTRY_PATH], {
      cwd: workingDirectory,
      env: buildServerEnvironment({ port, mongoUri, appOrigin }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const captureOutput = (chunk) => {
      capturedOutput = (capturedOutput + chunk.toString()).slice(-20_000);
    };
    serverProcess.stdout.on('data', captureOutput);
    serverProcess.stderr.on('data', captureOutput);
  }

  async function stop() {
    if (serverProcess && serverProcess.exitCode === null) {
      const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
      serverProcess.kill();
      await exited;
    }
    await database.dropDatabase().catch(() => {});
    await database.close().catch(() => {});
    await rm(workingDirectory, { recursive: true, force: true });
  }

  try {
    await database.asPromise();
    if (seedBeforeStart) await seedBeforeStart(database);
    spawnServer();
    await waitUntilHealthy(baseUrl, serverProcess, () => capturedOutput);
  } catch (startupError) {
    await stop();
    throw startupError;
  }

  return { baseUrl, database, createClient: () => new TestClient(baseUrl), stop };
}

/** A browser-like client: stores cookies from Set-Cookie and sends the CSRF token on writes. */
export class TestClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.csrfToken = null;
  }

  cookieHeader() {
    return [...this.cookies].map(([cookieName, cookieValue]) => `${cookieName}=${cookieValue}`).join('; ');
  }

  storeCookies(response) {
    for (const setCookieLine of response.headers.getSetCookie()) {
      const [nameValuePair, ...attributes] = setCookieLine.split(';');
      const separatorIndex = nameValuePair.indexOf('=');
      const cookieName = nameValuePair.slice(0, separatorIndex).trim();
      const cookieValue = nameValuePair.slice(separatorIndex + 1).trim();
      const isExpired = attributes.some((attribute) => {
        const [attributeName, attributeValue = ''] = attribute.trim().split('=');
        if (attributeName.toLowerCase() === 'max-age') return Number(attributeValue) <= 0;
        if (attributeName.toLowerCase() === 'expires') return new Date(attributeValue).getTime() <= Date.now();
        return false;
      });
      if (isExpired || cookieValue === '') this.cookies.delete(cookieName);
      else this.cookies.set(cookieName, cookieValue);
    }
  }

  /**
   * @param {string} method
   * @param {string} requestPath
   * @param {{ body?: unknown, sendCsrfToken?: boolean }} [options]
   * @returns {Promise<{ status: number, body: any }>}
   */
  async request(method, requestPath, { body, sendCsrfToken = true } = {}) {
    const headers = { Origin: TEST_APP_ORIGIN, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookies.size > 0) headers.Cookie = this.cookieHeader();
    if (sendCsrfToken && this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;

    const response = await fetch(`${this.baseUrl}${requestPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.storeCookies(response);
    const responseBody = await response.json().catch(() => null);
    if (typeof responseBody?.data?.csrfToken === 'string') this.csrfToken = responseBody.data.csrfToken;
    return { status: response.status, body: responseBody };
  }

  get(requestPath, options) {
    return this.request('GET', requestPath, options);
  }

  post(requestPath, body, options) {
    return this.request('POST', requestPath, { ...options, body });
  }

  patch(requestPath, body, options) {
    return this.request('PATCH', requestPath, { ...options, body });
  }

  signup(name, email, password = STRONG_PASSWORD) {
    return this.post('/api/auth/signup', { name, email, password });
  }

  login(email, password = STRONG_PASSWORD) {
    return this.post('/api/auth/login', { email, password });
  }
}

/**
 * Signs a new account up, optionally switches its role directly in the database (the same thing
 * scripts/setUserRole.js does), and returns a client signed in with that role.
 */
export async function createSignedInClient(testServer, { name, email, role = null }) {
  const client = testServer.createClient();
  const signupResponse = await client.signup(name, email);
  if (signupResponse.status !== 201) {
    throw new Error(`Signup for ${email} failed: ${signupResponse.status} ${JSON.stringify(signupResponse.body)}`);
  }
  if (role) {
    await testServer.database.collection('users').updateOne({ email }, { $set: { role } });
    const loginResponse = await client.login(email);
    if (loginResponse.status !== 200) {
      throw new Error(`Login for ${email} failed: ${loginResponse.status} ${JSON.stringify(loginResponse.body)}`);
    }
  }
  return client;
}
