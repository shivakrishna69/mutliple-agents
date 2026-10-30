/**
 * The shared layout of every email the platform sends: a header with the company name and a
 * heading, the message body, an optional call-to-action button with a copyable fallback link, and
 * a footer. Table layout with inline styles, which is what email clients render reliably.
 *
 * Text values (company name, heading, button label and link, footer) are escaped here. `bodyHtml`
 * and `action.noteHtml` are HTML the caller builds and must escape any user-supplied values in.
 */

import { escapeHtml } from '../utils/html.js';

/** The colours every email uses, in one place. */
export const EMAIL_THEME = Object.freeze({
  PAGE_BACKGROUND: '#f1f5f9',
  CARD_BACKGROUND: '#ffffff',
  TEXT: '#0f172a',
  MUTED_TEXT: '#64748b',
  FAINT_TEXT: '#94a3b8',
  DIVIDER: '#e2e8f0',
  ACCENT: '#c75000',
  ACCENT_GRADIENT_END: '#a54200',
  ON_ACCENT: '#ffffff',
});

function renderAction({ label, url, noteHtml }) {
  const theme = EMAIL_THEME;
  const note = noteHtml ? `${noteHtml}<br>` : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:${theme.ACCENT}">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 28px;color:${theme.ON_ACCENT};font-weight:600;font-size:15px;text-decoration:none">${escapeHtml(label)}</a>
</td></tr></table>
<p style="margin:20px 0 0;font-size:13px;color:${theme.MUTED_TEXT};line-height:1.6">${note}If the button doesn't work, paste this address into your browser:<br><span style="word-break:break-all;color:${theme.ACCENT}">${escapeHtml(url)}</span></p>`;
}

/**
 * @param {{ companyName: string, heading: string, bodyHtml: string,
 *           action?: { label: string, url: string, noteHtml?: string } | null, footerText: string }} content
 * @returns {string} a complete HTML document
 */
export function renderEmailLayout({ companyName, heading, bodyHtml, action = null, footerText }) {
  const theme = EMAIL_THEME;
  const actionHtml = action ? `\n${renderAction(action)}` : '';
  return `<!doctype html>
<html lang="en"><body style="margin:0;background:${theme.PAGE_BACKGROUND};font-family:Inter,Segoe UI,Arial,sans-serif;color:${theme.TEXT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${theme.PAGE_BACKGROUND};padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${theme.CARD_BACKGROUND};border-radius:16px;overflow:hidden">
<tr><td style="background:linear-gradient(135deg,${theme.ACCENT},${theme.ACCENT_GRADIENT_END});background-color:${theme.ACCENT};padding:28px 32px;color:${theme.ON_ACCENT}">
<p style="margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">${escapeHtml(companyName)}</p>
<h1 style="margin:8px 0 0;font-size:22px;line-height:1.3">${escapeHtml(heading)}</h1>
</td></tr>
<tr><td style="padding:28px 32px">
${bodyHtml}${actionHtml}
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid ${theme.DIVIDER};font-size:12px;color:${theme.FAINT_TEXT}">${escapeHtml(footerText)}</td></tr>
</table></td></tr></table></body></html>`;
}
