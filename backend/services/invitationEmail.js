/**
 * The invitation email: an HTML version (the shared layout in services/emailLayout.js) and a
 * plain-text version. Every interpolated value is HTML-escaped; the link is built by the caller
 * from APP_PUBLIC_URL and a URL-safe token.
 */

import { renderEmailLayout } from './emailLayout.js';
import { escapeHtml } from '../utils/html.js';

/**
 * @param {{ inviteeName: string, inviterName: string, companyName: string, designation: string,
 *           departmentName: string|null, inviteUrl: string, expiresAt: Date }} details
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildInvitationEmail({
  inviteeName,
  inviterName,
  companyName,
  designation,
  departmentName,
  inviteUrl,
  expiresAt,
}) {
  const expiryText = expiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const roleLine = departmentName ? `${designation}, ${departmentName}` : designation;
  const subject = `${inviterName} invited you to join ${companyName}`;
  const footerText = "If you weren't expecting this invitation, you can ignore this email.";

  const text = [
    `Hi ${inviteeName},`,
    '',
    `${inviterName} has invited you to join ${companyName} as ${roleLine}.`,
    '',
    'Set your password to activate your account:',
    inviteUrl,
    '',
    `This link works once and expires on ${expiryText}.`,
    footerText,
  ].join('\n');

  const html = renderEmailLayout({
    companyName,
    heading: "You're invited to join the team",
    bodyHtml: `<p style="margin:0 0 12px;font-size:15px">Hi ${escapeHtml(inviteeName)},</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6"><strong>${escapeHtml(inviterName)}</strong> has invited you to join <strong>${escapeHtml(companyName)}</strong> as <strong>${escapeHtml(roleLine)}</strong>.</p>`,
    action: {
      label: 'Activate my account',
      url: inviteUrl,
      noteHtml: `This link works once and expires on ${escapeHtml(expiryText)}.`,
    },
    footerText,
  });

  return { subject, html, text };
}
