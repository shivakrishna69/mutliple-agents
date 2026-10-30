/**
 * Loads and validates the backend configuration from environment variables. Any missing or unsafe
 * value stops startup with a clear message (fail fast); optional integrations (S3, SMTP, Redis) are
 * switched off when their variables are unset.
 */

import { EMAIL_PATTERN } from '../constants/validation.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Minimum length for every HMAC secret (JWT, webhook signing, internal AI-service key).
 * HMAC-SHA256 needs a key at least as long as its 256-bit output; shorter secrets can be
 * brute-forced offline from a single signed value.
 */
const MIN_SECRET_LENGTH = 32;
// The name in emails when the deployment sets neither COMPANY_NAME nor COMPANY_LEGAL_NAME.
const DEFAULT_COMPANY_NAME = 'NSK Software Technologies';

/** Bounds for AI_SERVICE_TIMEOUT_MS: long enough for an LLM round trip, short enough not to hang webhooks. */
const AI_SERVICE_TIMEOUT_BOUNDS_MS = Object.freeze({ MIN: 1_000, MAX: 120_000, DEFAULT: 20_000 });

/**
 * S3 bucket naming rules (3-63 characters, lowercase letters, digits, dots and hyphens, starting and
 * ending with a letter or digit).
 */
const S3_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
// e.g. ap-south-1, us-east-1, us-gov-west-1
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

/**
 * Reads one S3 storage area's settings from `<envPrefix>_S3_*` variables (VAULT_ for the document
 * vault, PAYSLIP_ for payslip PDFs). Returns null when `<envPrefix>_S3_BUCKET` is unset, which
 * disables that feature (its routes answer 503; the rest of the backend runs normally). When a
 * bucket is set, every related value is validated and a misconfiguration stops startup. AWS
 * credentials are deliberately not read here; the SDK's default provider chain supplies them
 * (IAM role in production). AWS_REGION is shared by all storage areas.
 *
 *   <P>_S3_BUCKET            bucket name
 *   <P>_S3_SSE               aws:kms (default) | AES256
 *   <P>_S3_KMS_KEY_ID        optional customer-managed key, aws:kms only
 *   <P>_S3_ENDPOINT          optional S3-compatible endpoint (https in production)
 *   <P>_S3_FORCE_PATH_STYLE  "true" for stores that need path-style URLs
 */
function loadS3StorageConfig(env, envPrefix) {
  const readSetting = (suffix) => process.env[`${envPrefix}_S3_${suffix}`];
  const settingName = (suffix) => `${envPrefix}_S3_${suffix}`;

  const bucketName = readSetting('BUCKET') ? readSetting('BUCKET').trim() : '';
  if (!bucketName) return null;
  if (!S3_BUCKET_NAME_PATTERN.test(bucketName) || bucketName.includes('..')) {
    throw new Error(`${settingName('BUCKET')} is not a valid S3 bucket name`);
  }

  const region = (process.env.AWS_REGION ?? '').trim();
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error(
      `AWS_REGION must be set to the bucket's region (e.g. ap-south-1) when ${settingName('BUCKET')} is set`,
    );
  }

  const serverSideEncryption = (readSetting('SSE') ?? 'aws:kms').trim();
  if (!['aws:kms', 'AES256'].includes(serverSideEncryption)) {
    throw new Error(`${settingName('SSE')} must be "aws:kms" or "AES256"`);
  }
  const kmsKeyId = readSetting('KMS_KEY_ID') ? readSetting('KMS_KEY_ID').trim() : null;
  if (kmsKeyId && serverSideEncryption !== 'aws:kms') {
    throw new Error(`${settingName('KMS_KEY_ID')} can only be used with ${settingName('SSE')}=aws:kms`);
  }

  // Optional endpoint for S3-compatible stores. Production traffic must stay on TLS.
  const rawEndpoint = readSetting('ENDPOINT') ? readSetting('ENDPOINT').trim() : null;
  let endpoint = null;
  if (rawEndpoint) {
    let parsedEndpoint;
    try {
      parsedEndpoint = new URL(rawEndpoint);
    } catch {
      throw new Error(`${settingName('ENDPOINT')} must be an absolute URL`);
    }
    if (!['http:', 'https:'].includes(parsedEndpoint.protocol))
      throw new Error(`${settingName('ENDPOINT')} must use http or https`);
    if (env === 'production' && parsedEndpoint.protocol !== 'https:')
      throw new Error(`${settingName('ENDPOINT')} must use https in production`);
    endpoint = parsedEndpoint.origin;
  }

  const forcePathStyleSetting = readSetting('FORCE_PATH_STYLE');
  if (
    forcePathStyleSetting !== undefined &&
    forcePathStyleSetting !== '' &&
    !['true', 'false'].includes(forcePathStyleSetting)
  ) {
    throw new Error(`${settingName('FORCE_PATH_STYLE')} must be "true" or "false"`);
  }

  return {
    bucketName,
    region,
    serverSideEncryption,
    kmsKeyId,
    endpoint,
    forcePathStyle: forcePathStyleSetting === 'true',
  };
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const PDF_BROWSER_CHANNELS = Object.freeze(['chrome', 'chrome-beta', 'msedge', 'msedge-beta', 'chromium']);

/**
 * Payslip generation settings (services/payslipService.js). Disabled (null) unless
 * PAYSLIP_S3_BUCKET is set; when it is, everything a payslip needs must be configured:
 *   COMPANY_LEGAL_NAME, COMPANY_REGISTERED_ADDRESS   printed in the payslip header
 *   COMPANY_BRAND_COLOR                              optional "#RRGGBB" accent (default #c75000)
 *   PAYSLIP_SIGNING_SECRET                           HMAC key for verification IDs (≥ 32 chars)
 *   PAYSLIP_VERIFICATION_BASE_URL                    optional public URL printed next to the ID
 *   PDF_BROWSER_EXECUTABLE_PATH | PDF_BROWSER_CHANNEL  the Chromium build that renders PDFs
 */
function loadPayslipConfig(env) {
  const storage = loadS3StorageConfig(env, 'PAYSLIP');
  if (!storage) return null;

  const companyLegalName = (process.env.COMPANY_LEGAL_NAME ?? '').trim();
  const companyRegisteredAddress = (process.env.COMPANY_REGISTERED_ADDRESS ?? '').trim();
  if (companyLegalName.length < 2 || companyLegalName.length > 200) {
    throw new Error('COMPANY_LEGAL_NAME (2-200 characters) is required when PAYSLIP_S3_BUCKET is set');
  }
  if (companyRegisteredAddress.length < 5 || companyRegisteredAddress.length > 400) {
    throw new Error('COMPANY_REGISTERED_ADDRESS (5-400 characters) is required when PAYSLIP_S3_BUCKET is set');
  }
  const brandColor = (process.env.COMPANY_BRAND_COLOR ?? '#c75000').trim();
  if (!HEX_COLOR_PATTERN.test(brandColor)) throw new Error('COMPANY_BRAND_COLOR must be a hex colour such as #c75000');

  const signingSecret = process.env.PAYSLIP_SIGNING_SECRET ?? '';
  if (signingSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `PAYSLIP_SIGNING_SECRET is required when PAYSLIP_S3_BUCKET is set and must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  if (signingSecret === process.env.JWT_SECRET) throw new Error('PAYSLIP_SIGNING_SECRET must differ from JWT_SECRET');

  let verificationBaseUrl = null;
  if (process.env.PAYSLIP_VERIFICATION_BASE_URL) {
    try {
      const parsedUrl = new URL(process.env.PAYSLIP_VERIFICATION_BASE_URL.trim());
      if (env === 'production' && parsedUrl.protocol !== 'https:') throw new Error('not https');
      verificationBaseUrl = parsedUrl.toString().replace(/\/+$/, '');
    } catch {
      throw new Error('PAYSLIP_VERIFICATION_BASE_URL must be an absolute URL (https in production)');
    }
  }

  const browserExecutablePath = (process.env.PDF_BROWSER_EXECUTABLE_PATH ?? '').trim() || null;
  const browserChannel = (process.env.PDF_BROWSER_CHANNEL ?? '').trim() || null;
  if (!browserExecutablePath && !browserChannel) {
    throw new Error('PDF_BROWSER_EXECUTABLE_PATH or PDF_BROWSER_CHANNEL is required when PAYSLIP_S3_BUCKET is set');
  }
  if (browserChannel && !PDF_BROWSER_CHANNELS.includes(browserChannel)) {
    throw new Error(`PDF_BROWSER_CHANNEL must be one of ${PDF_BROWSER_CHANNELS.join(', ')}`);
  }

  return {
    storage,
    signingSecret,
    verificationBaseUrl,
    company: { legalName: companyLegalName, registeredAddress: companyRegisteredAddress, brandColor },
    pdfBrowser: { executablePath: browserExecutablePath, channel: browserExecutablePath ? null : browserChannel },
  };
}

/**
 * Reads configuration from the environment and throws if a required value is missing.
 * Every other module receives this object rather than reading `process.env` directly,
 * so the full set of settings the backend depends on is visible in one place.
 * `createApp` exposes it to request handlers as `req.app.locals.config`.
 */
/**
 * Optional outgoing email (employee invitations) and the public address used in emailed links.
 *   SMTP_HOST                 enables email; without it invitation links are shown to HR instead
 *   SMTP_PORT (587), SMTP_SECURE ("true" for implicit TLS on 465), SMTP_USER, SMTP_PASSWORD
 *   SMTP_REQUIRE_TLS          default "true"; "false" only outside production, for local mail
 *                             catchers (Mailpit, MailHog) that do not offer STARTTLS
 *   MAIL_FROM                 required with SMTP_HOST, e.g. "NSK HR <hr@yourcompany.com>"
 *   APP_PUBLIC_URL            where people open the app (default: the first CORS origin);
 *                             must be https in production
 *   COMPANY_NAME              shown in invitation emails (default: COMPANY_LEGAL_NAME, else "NSK Software Technologies")
 */
function loadMailAndPublicConfig(env, corsOrigins) {
  const appPublicUrlSetting = (process.env.APP_PUBLIC_URL ?? corsOrigins[0] ?? '').trim().replace(/\/+$/, '');
  let parsedPublicUrl;
  try {
    parsedPublicUrl = new URL(appPublicUrlSetting);
  } catch {
    throw new Error('APP_PUBLIC_URL must be an absolute URL (or set CORS_ORIGINS)');
  }
  if (!['http:', 'https:'].includes(parsedPublicUrl.protocol)) throw new Error('APP_PUBLIC_URL must use http or https');
  if (env === 'production' && parsedPublicUrl.protocol !== 'https:')
    throw new Error('APP_PUBLIC_URL must use https in production');

  const companyName =
    (process.env.COMPANY_NAME ?? process.env.COMPANY_LEGAL_NAME ?? DEFAULT_COMPANY_NAME).trim().slice(0, 120) ||
    DEFAULT_COMPANY_NAME;

  const smtpHost = (process.env.SMTP_HOST ?? '').trim();
  if (!smtpHost) return { mail: null, appPublicUrl: parsedPublicUrl.origin, companyName };
  const smtpPort = Number(process.env.SMTP_PORT ?? 587);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)
    throw new Error('SMTP_PORT must be a port number');
  const smtpSecureSetting = process.env.SMTP_SECURE;
  if (smtpSecureSetting !== undefined && !['true', 'false'].includes(smtpSecureSetting))
    throw new Error('SMTP_SECURE must be "true" or "false"');
  const mailFrom = (process.env.MAIL_FROM ?? '').trim();
  if (!mailFrom) throw new Error('MAIL_FROM is required when SMTP_HOST is set');
  const requireTlsSetting = process.env.SMTP_REQUIRE_TLS;
  if (requireTlsSetting !== undefined && !['true', 'false'].includes(requireTlsSetting))
    throw new Error('SMTP_REQUIRE_TLS must be "true" or "false"');
  if (env === 'production' && requireTlsSetting === 'false')
    throw new Error('SMTP_REQUIRE_TLS cannot be "false" in production');
  const smtpUser = (process.env.SMTP_USER ?? '').trim() || null;
  if (smtpUser && !process.env.SMTP_PASSWORD) throw new Error('SMTP_PASSWORD is required when SMTP_USER is set');
  return {
    mail: {
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecureSetting === undefined ? smtpPort === 465 : smtpSecureSetting === 'true',
      user: smtpUser,
      password: smtpUser ? process.env.SMTP_PASSWORD : null,
      from: mailFrom,
      requireTls: requireTlsSetting !== 'false',
    },
    appPublicUrl: parsedPublicUrl.origin,
    companyName,
  };
}

export function loadConfig() {
  const required = ['MONGO_URI', 'JWT_SECRET', 'WEBHOOK_SIGNING_SECRET', 'AI_SERVICE_API_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  for (const secretName of ['JWT_SECRET', 'WEBHOOK_SIGNING_SECRET', 'AI_SERVICE_API_KEY']) {
    if (process.env[secretName].length < MIN_SECRET_LENGTH) {
      throw new Error(`${secretName} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }
  if (
    new Set([process.env.JWT_SECRET, process.env.WEBHOOK_SIGNING_SECRET, process.env.AI_SERVICE_API_KEY]).size !== 3
  ) {
    // Reusing one secret would let a leak in one integration forge credentials for the others.
    throw new Error('JWT_SECRET, WEBHOOK_SIGNING_SECRET and AI_SERVICE_API_KEY must all be different');
  }

  const aiServiceUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
  let parsedAiServiceUrl;
  try {
    parsedAiServiceUrl = new URL(aiServiceUrl);
  } catch {
    throw new Error('AI_SERVICE_URL must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(parsedAiServiceUrl.protocol)) {
    throw new Error('AI_SERVICE_URL must use http or https');
  }

  const aiServiceTimeoutMs = Number(process.env.AI_SERVICE_TIMEOUT_MS ?? AI_SERVICE_TIMEOUT_BOUNDS_MS.DEFAULT);
  if (
    !Number.isInteger(aiServiceTimeoutMs) ||
    aiServiceTimeoutMs < AI_SERVICE_TIMEOUT_BOUNDS_MS.MIN ||
    aiServiceTimeoutMs > AI_SERVICE_TIMEOUT_BOUNDS_MS.MAX
  ) {
    throw new Error(
      `AI_SERVICE_TIMEOUT_MS must be an integer between ${AI_SERVICE_TIMEOUT_BOUNDS_MS.MIN} and ${AI_SERVICE_TIMEOUT_BOUNDS_MS.MAX}`,
    );
  }

  const env = process.env.NODE_ENV ?? 'development';

  // Secure cookies are only sent over HTTPS. Defaults to on in production, off elsewhere so the
  // http:// dev server works in every browser; turning it off in production is refused outright.
  const cookieSecureSetting = process.env.COOKIE_SECURE;
  if (cookieSecureSetting !== undefined && !['true', 'false'].includes(cookieSecureSetting)) {
    throw new Error('COOKIE_SECURE must be "true" or "false"');
  }
  const cookieSecure = cookieSecureSetting === undefined ? env === 'production' : cookieSecureSetting === 'true';
  if (env === 'production' && !cookieSecure) {
    throw new Error('COOKIE_SECURE cannot be "false" in production');
  }

  // Number of reverse proxies in front of the app. Express uses it to take the client IP from
  // X-Forwarded-For; 0 ignores that header, so clients cannot spoof their IP to dodge rate limits.
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error('TRUST_PROXY_HOPS must be a non-negative integer');
  }

  // Optional. The account that becomes the first administrator (see services/bootstrapAdmin.js).
  const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL
    ? process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase()
    : null;
  if (bootstrapAdminEmail && !EMAIL_PATTERN.test(bootstrapAdminEmail)) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email address');
  }

  // Optional. When set, Socket.IO rooms are shared across instances through Redis.
  const redisUrl = process.env.REDIS_URL ? process.env.REDIS_URL.trim() : null;
  if (redisUrl) {
    let parsedRedisUrl;
    try {
      parsedRedisUrl = new URL(redisUrl);
    } catch {
      throw new Error('REDIS_URL must be an absolute URL, e.g. redis://localhost:6379');
    }
    if (!['redis:', 'rediss:'].includes(parsedRedisUrl.protocol)) {
      throw new Error('REDIS_URL must use the redis:// or rediss:// (TLS) scheme');
    }
  }

  // Optional. Employee document vault storage; null disables the vault.
  const vaultStorage = loadS3StorageConfig(env, 'VAULT');
  // Optional. Payslip PDF generation and storage; null disables it.
  const payslips = loadPayslipConfig(env);

  const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  // Optional. Invitation email (null mail = links shown to HR) and the public app address.
  const { mail, appPublicUrl, companyName } = loadMailAndPublicConfig(env, corsOrigins);

  return {
    env,
    cookieSecure,
    redisUrl,
    vaultStorage,
    payslips,
    bootstrapAdminEmail,
    trustProxyHops,
    port: Number(process.env.PORT ?? 5000),
    mongoUri: process.env.MONGO_URI,
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
    corsOrigins,
    mail,
    appPublicUrl,
    companyName,
    aiServiceUrl: parsedAiServiceUrl.origin,
    aiServiceTimeoutMs,
    aiServiceApiKey: process.env.AI_SERVICE_API_KEY,
    webhookSigningSecret: process.env.WEBHOOK_SIGNING_SECRET,
  };
}
