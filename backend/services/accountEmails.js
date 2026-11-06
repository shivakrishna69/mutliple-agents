/**
 * The emails about a person's own account: confirm your email, reset your password, your password
 * was changed, and "you already have an account". Each has an HTML version (the shared layout in
 * services/emailLayout.js) and a plain-text version. Every interpolated value is HTML-escaped; links
 * are built by the caller from APP_PUBLIC_URL and a URL-safe token.
 */

import { EMAIL_THEME, renderEmailLayout } from './emailLayout.js';
import { escapeHtml } from '../utils/html.js';

const paragraph = (html) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6">${html}</p>`;

/** "24 hours", "1 hour", "30 minutes": a validity period as the emails state it. */
export function describeDuration(durationMs) {
  const minutes = Math.round(durationMs / 60_000);
  if (minutes % 60 !== 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** An emailed code, shown large under its label, to type on the screen that asks for it. */
function codeBlockHtml(label, code) {
  return `<p style="margin:0 0 6px;font-size:13px;color:${EMAIL_THEME.MUTED_TEXT}">${escapeHtml(label)}</p>
<p style="margin:0 0 24px;font-size:32px;font-weight:700;letter-spacing:.3em;color:${EMAIL_THEME.TEXT}">${escapeHtml(code)}</p>`;
}

/**
 * The code is shown large to type on the "check your email" page; the link does the same in one
 * click. Both work once and expire together.
 * @param {{ name: string, companyName: string, verificationUrl: string, verificationCode: string,
 *   validityMs: number }} details
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildVerificationEmail({ name, companyName, verificationUrl, verificationCode, validityMs }) {
  const validity = describeDuration(validityMs);
  const footerText =
    "If you didn't create an account, you can ignore this email; nothing happens without the code or link.";
  const text = [
    `Hi ${name},`,
    '',
    `Your code to confirm your email for ${companyName}: ${verificationCode}`,
    '',
    'Or confirm in one click:',
    verificationUrl,
    '',
    `The code and the link work once and expire in ${validity}.`,
    footerText,
  ].join('\n');
  const html = renderEmailLayout({
    companyName,
    heading: 'Confirm your email address',
    bodyHtml: `${paragraph(`Hi ${escapeHtml(name)},`)}${paragraph(
      `Enter this code on the confirmation page to finish creating your <strong>${escapeHtml(companyName)}</strong> account, or use the button below.`,
    )}${codeBlockHtml('Your confirmation code', verificationCode)}`,
    action: {
      label: 'Confirm my email',
      url: verificationUrl,
      noteHtml: `The code and the link work once and expire in ${escapeHtml(validity)}.`,
    },
    footerText,
  });
  return { subject: `${verificationCode} is your ${companyName} confirmation code`, html, text };
}

/**
 * The code is typed on the reset screen; the link opens that screen ready to choose a password.
 * Both are one record: using either one uses up the other, and they expire together.
 * @param {{ name: string, companyName: string, resetUrl: string, resetCode: string, validityMs: number }} details
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildPasswordResetEmail({ name, companyName, resetUrl, resetCode, validityMs }) {
  const validity = describeDuration(validityMs);
  const footerText = "If you didn't ask to reset your password, ignore this email: your password stays as it is.";
  const text = [
    `Hi ${name},`,
    '',
    `Someone asked to reset the password of your ${companyName} account. Your code to reset it: ${resetCode}`,
    '',
    'Or choose a new password here:',
    resetUrl,
    '',
    `The code and the link work once and expire in ${validity}.`,
    footerText,
  ].join('\n');
  const html = renderEmailLayout({
    companyName,
    heading: 'Reset your password',
    bodyHtml: `${paragraph(`Hi ${escapeHtml(name)},`)}${paragraph(
      `Someone asked to reset the password of your <strong>${escapeHtml(companyName)}</strong> account. If it was you, enter this code on the reset page, or use the button below.`,
    )}${codeBlockHtml('Your password reset code', resetCode)}`,
    action: {
      label: 'Choose a new password',
      url: resetUrl,
      noteHtml: `The code and the link work once and expire in ${escapeHtml(validity)}.`,
    },
    footerText,
  });
  return { subject: `${resetCode} is your ${companyName} password reset code`, html, text };
}

/**
 * Sent after a password reset, so the owner learns of a reset they did not ask for.
 * @param {{ name: string, companyName: string, signInUrl: string, changedAt: Date }} details
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildPasswordChangedEmail({ name, companyName, signInUrl, changedAt }) {
  const changedAtText = `${changedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const footerText = 'You are receiving this because the password of your account changed.';
  const warning =
    "If you didn't do this, reset your password straight away from the sign-in page and tell your administrator.";
  const text = [
    `Hi ${name},`,
    '',
    `The password of your ${companyName} account was changed on ${changedAtText}, and every device was signed out.`,
    '',
    warning,
    signInUrl,
    '',
    footerText,
  ].join('\n');
  const html = renderEmailLayout({
    companyName,
    heading: 'Your password was changed',
    bodyHtml: `${paragraph(`Hi ${escapeHtml(name)},`)}${paragraph(
      `The password of your <strong>${escapeHtml(companyName)}</strong> account was changed on ${escapeHtml(changedAtText)}, and every device was signed out.`,
    )}${paragraph(escapeHtml(warning))}`,
    action: { label: 'Go to sign-in', url: signInUrl },
    footerText,
  });
  return { subject: `Your ${companyName} password was changed`, html, text };
}

/**
 * Sent when someone signs up with an address that already has an account: the owner learns of it,
 * and the signup page answers exactly as it does for a new address.
 * @param {{ name: string, companyName: string, signInUrl: string, forgotPasswordUrl: string }} details
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildAccountExistsEmail({ name, companyName, signInUrl, forgotPasswordUrl }) {
  const footerText = "If this wasn't you, you can ignore this email; your account is unchanged.";
  const text = [
    `Hi ${name},`,
    '',
    `Someone tried to create a ${companyName} account with this email address, but you already have one.`,
    `Sign in: ${signInUrl}`,
    `Forgot your password? ${forgotPasswordUrl}`,
    '',
    footerText,
  ].join('\n');
  const html = renderEmailLayout({
    companyName,
    heading: 'You already have an account',
    bodyHtml: `${paragraph(`Hi ${escapeHtml(name)},`)}${paragraph(
      `Someone tried to create a <strong>${escapeHtml(companyName)}</strong> account with this email address, but you already have one.`,
    )}${paragraph(`Forgot your password? <a href="${escapeHtml(forgotPasswordUrl)}">Reset it here</a>.`)}`,
    action: { label: 'Sign in', url: signInUrl },
    footerText,
  });
  return { subject: `You already have a ${companyName} account`, html, text };
}
