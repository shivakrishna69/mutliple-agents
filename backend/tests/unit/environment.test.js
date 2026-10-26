/**
 * Startup configuration (config/environment.js): unsafe or malformed settings must stop the server
 * with a clear message instead of running quietly.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../config/environment.js';

const VALID_ENVIRONMENT = Object.freeze({
  MONGO_URI: 'mongodb://127.0.0.1:27017/nova',
  JWT_SECRET: 'j'.repeat(32),
  WEBHOOK_SIGNING_SECRET: 'w'.repeat(32),
  AI_SERVICE_API_KEY: 'a'.repeat(32),
});

let savedEnvironment;

beforeEach(() => {
  savedEnvironment = process.env;
});

afterEach(() => {
  process.env = savedEnvironment;
});

/** Runs loadConfig against exactly these variables (nothing inherited from the machine). */
function loadWith(overrides = {}) {
  process.env = { ...VALID_ENVIRONMENT, ...overrides };
  for (const [name, value] of Object.entries(process.env)) if (value === undefined) delete process.env[name];
  return loadConfig();
}

describe('loadConfig', () => {
  it('accepts the minimal configuration with development defaults', () => {
    const config = loadWith();
    assert.equal(config.env, 'development');
    assert.equal(config.port, 5000);
    assert.equal(config.cookieSecure, false);
    assert.equal(config.trustProxyHops, 0);
    assert.deepEqual(config.corsOrigins, ['http://localhost:5173']);
    assert.equal(config.aiServiceUrl, 'http://localhost:8000');
    assert.equal(config.redisUrl, null);
    assert.equal(config.vaultStorage, null);
    assert.equal(config.payslips, null);
  });

  it('names every missing required variable', () => {
    assert.throws(
      () => loadWith({ MONGO_URI: undefined, JWT_SECRET: undefined }),
      /Missing required environment variables: MONGO_URI, JWT_SECRET/,
    );
  });

  it('refuses short secrets and one secret reused for two purposes', () => {
    assert.throws(() => loadWith({ JWT_SECRET: 'short' }), /JWT_SECRET must be at least 32 characters/);
    assert.throws(() => loadWith({ AI_SERVICE_API_KEY: 'j'.repeat(32) }), /must all be different/);
  });

  it('requires secure cookies in production and turns them on by default there', () => {
    assert.throws(
      () => loadWith({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
      /COOKIE_SECURE cannot be "false" in production/,
    );
    assert.equal(loadWith({ NODE_ENV: 'production', APP_PUBLIC_URL: 'https://hr.example.com' }).cookieSecure, true);
  });

  it('requires https public URLs in production', () => {
    assert.throws(
      () => loadWith({ NODE_ENV: 'production', APP_PUBLIC_URL: 'http://hr.example.com' }),
      /APP_PUBLIC_URL must use https in production/,
    );
  });

  it('parses the CORS allow-list and uses its first origin as the public URL by default', () => {
    const config = loadWith({ CORS_ORIGINS: ' https://hr.example.com , https://admin.example.com ,' });
    assert.deepEqual(config.corsOrigins, ['https://hr.example.com', 'https://admin.example.com']);
    assert.equal(config.appPublicUrl, 'https://hr.example.com');
  });

  it('validates the AI service address and timeout', () => {
    assert.throws(() => loadWith({ AI_SERVICE_URL: 'not a url' }), /AI_SERVICE_URL must be an absolute URL/);
    assert.throws(() => loadWith({ AI_SERVICE_URL: 'ftp://ai:8000' }), /AI_SERVICE_URL must use http or https/);
    assert.throws(() => loadWith({ AI_SERVICE_TIMEOUT_MS: '50' }), /AI_SERVICE_TIMEOUT_MS must be an integer/);
    assert.equal(loadWith({ AI_SERVICE_URL: 'http://ai-service:8000/' }).aiServiceUrl, 'http://ai-service:8000');
  });

  it('validates proxy hops, the bootstrap admin email and the Redis URL', () => {
    assert.throws(() => loadWith({ TRUST_PROXY_HOPS: '-1' }), /TRUST_PROXY_HOPS must be a non-negative integer/);
    assert.throws(() => loadWith({ BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' }), /BOOTSTRAP_ADMIN_EMAIL must be a valid/);
    assert.equal(loadWith({ BOOTSTRAP_ADMIN_EMAIL: ' Admin@Example.COM ' }).bootstrapAdminEmail, 'admin@example.com');
    assert.throws(
      () => loadWith({ REDIS_URL: 'http://redis:6379' }),
      /REDIS_URL must use the redis:\/\/ or rediss:\/\//,
    );
    assert.equal(loadWith({ REDIS_URL: 'redis://redis:6379' }).redisUrl, 'redis://redis:6379');
  });

  it('requires the company details and a signing secret before payslips can be enabled', () => {
    const payslipBucket = { PAYSLIP_S3_BUCKET: 'company-payslips', AWS_REGION: 'ap-south-1' };
    assert.throws(() => loadWith(payslipBucket), /COMPANY_LEGAL_NAME .* is required when PAYSLIP_S3_BUCKET is set/);
    assert.throws(
      () =>
        loadWith({
          ...payslipBucket,
          COMPANY_LEGAL_NAME: 'Nova Labs Pvt Ltd',
          COMPANY_REGISTERED_ADDRESS: '1 MG Road, Bengaluru',
          PAYSLIP_SIGNING_SECRET: 'j'.repeat(32),
        }),
      /PAYSLIP_SIGNING_SECRET must differ from JWT_SECRET/,
    );
  });

  it('requires a sender and a password when SMTP is configured', () => {
    assert.throws(() => loadWith({ SMTP_HOST: 'smtp.example.com' }), /MAIL_FROM is required when SMTP_HOST is set/);
    assert.throws(
      () => loadWith({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'hr@example.com', SMTP_USER: 'hr' }),
      /SMTP_PASSWORD is required when SMTP_USER is set/,
    );
  });
});
