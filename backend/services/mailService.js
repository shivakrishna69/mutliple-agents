/**
 * Outgoing email over SMTP (nodemailer), used for employee invitations.
 *
 * Configuration (server.js loadMailConfig):
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE ("true" for port 465), SMTP_USER, SMTP_PASSWORD, MAIL_FROM
 * Without SMTP_HOST the service is "not configured": sendMail returns { outcome: 'not_configured' }
 * instead of throwing, and callers decide what to do (invitations then show HR a link to share).
 *
 * Delivery semantics: "sent" means the SMTP server accepted the message, not that it reached the
 * inbox. Failures are logged with the error code only; recipient addresses and message bodies are
 * never logged.
 */

import nodemailer from 'nodemailer';
import { logger } from '../utils/logger.js';

const SMTP_TIMEOUTS = Object.freeze({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });

let mailTransport = null;
let mailFrom = null;

export const MAIL_OUTCOMES = Object.freeze({ SENT: 'sent', NOT_CONFIGURED: 'not_configured', FAILED: 'failed' });

/**
 * @param {{ host: string, port: number, secure: boolean, user: string|null, password: string|null, from: string, requireTls: boolean } | null} mailConfig
 */
export function initMailService(mailConfig) {
  if (!mailConfig) {
    logger.warn('Email is not configured (SMTP_HOST unset): invitation links are shown to HR instead of being emailed');
    return;
  }
  mailTransport = nodemailer.createTransport({
    host: mailConfig.host,
    port: mailConfig.port,
    secure: mailConfig.secure,
    // Upgrade to TLS whenever the server offers it; refuse plaintext AUTH over port 587.
    // (SMTP_REQUIRE_TLS=false is only accepted outside production, for local mail catchers.)
    requireTLS: !mailConfig.secure && mailConfig.requireTls,
    auth: mailConfig.user ? { user: mailConfig.user, pass: mailConfig.password } : undefined,
    pool: true,
    maxConnections: 3,
    ...SMTP_TIMEOUTS,
  });
  mailFrom = mailConfig.from;
  logger.info('Email service initialised', { host: mailConfig.host, port: mailConfig.port });
}

export function isMailConfigured() {
  return mailTransport !== null;
}

/**
 * Sends one message. Never throws.
 * @param {{ to: string, subject: string, html: string, text: string }} message
 * @returns {Promise<{ outcome: 'sent'|'not_configured'|'failed' }>}
 */
export async function sendMail({ to, subject, html, text }) {
  if (!mailTransport) return { outcome: MAIL_OUTCOMES.NOT_CONFIGURED };
  try {
    await mailTransport.sendMail({ from: mailFrom, to, subject, html, text });
    return { outcome: MAIL_OUTCOMES.SENT };
  } catch (mailError) {
    logger.error('Email delivery failed', { code: mailError.code ?? null, responseCode: mailError.responseCode ?? null, message: String(mailError.message).slice(0, 200) });
    return { outcome: MAIL_OUTCOMES.FAILED };
  }
}

export function closeMailService() {
  mailTransport?.close();
  mailTransport = null;
}
