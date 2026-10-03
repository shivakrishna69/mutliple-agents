/**
 * The invitation email: an HTML version (inline styles, table layout, which is what email clients
 * render reliably) and a plain-text version. Every interpolated value is HTML-escaped; the link is
 * built by the caller from APP_PUBLIC_URL and a URL-safe token.
 */

import { escapeHtml } from './payslipHtmlTemplate.js';

/**
 * @param {{ inviteeName: string, inviterName: string, companyName: string, designation: string,
 *           departmentName: string|null, inviteUrl: string, expiresAt: Date }} details
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildInvitationEmail({ inviteeName, inviterName, companyName, designation, departmentName, inviteUrl, expiresAt }) {
  const expiryText = expiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const roleLine = departmentName ? `${designation}, ${departmentName}` : designation;
  const subject = `${inviterName} invited you to join ${companyName}`;

  const text = [
    `Hi ${inviteeName},`,
    '',
    `${inviterName} has invited you to join ${companyName} as ${roleLine}.`,
    '',
    'Set your password to activate your account:',
    inviteUrl,
    '',
    `This link works once and expires on ${expiryText}.`,
    "If you weren't expecting this invitation, you can ignore this email.",
  ].join('\n');

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);background-color:#4f46e5;padding:28px 32px;color:#ffffff">
<p style="margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">${escapeHtml(companyName)}</p>
<h1 style="margin:8px 0 0;font-size:22px;line-height:1.3">You're invited to join the team</h1>
</td></tr>
<tr><td style="padding:28px 32px">
<p style="margin:0 0 12px;font-size:15px">Hi ${escapeHtml(inviteeName)},</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6"><strong>${escapeHtml(inviterName)}</strong> has invited you to join <strong>${escapeHtml(companyName)}</strong> as <strong>${escapeHtml(roleLine)}</strong>.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#4f46e5">
<a href="${escapeHtml(inviteUrl)}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-weight:600;font-size:15px;text-decoration:none">Activate my account</a>
</td></tr></table>
<p style="margin:20px 0 0;font-size:13px;color:#64748b;line-height:1.6">This link works once and expires on ${escapeHtml(expiryText)}.<br>If the button doesn't work, paste this address into your browser:<br><span style="word-break:break-all;color:#4f46e5">${escapeHtml(inviteUrl)}</span></p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8">If you weren't expecting this invitation, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;

  return { subject, html, text };
}
