/**
 * The email that carries an offer (services/onboardingService.js dispatch): the offer letter PDF as
 * an attachment, how to open it (the date of birth written DDMMYYYY, described, never stated), and
 * the activation link with its expiry. Built on the shared email layout (services/emailLayout.js);
 * every interpolated value is HTML-escaped.
 */

import { OFFER_LETTER_PROTECTION } from '../constants/validation.js';
import { escapeHtml } from '../utils/html.js';
import { EMAIL_THEME, renderEmailLayout } from './emailLayout.js';

const paragraph = (html) =>
  `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${EMAIL_THEME.TEXT}">${html}</p>`;

/**
 * @param {{ candidateName: string, companyName: string, designation: string, dateOfJoining: Date,
 *   employeeCode: string|null, activationUrl: string, expiresAt: Date, letterFilename: string,
 *   timeZone: string }} details
 *   timeZone: the company's (CompanySettings.timeZone), for the link's expiry time
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildOfferEmail({
  candidateName,
  companyName,
  designation,
  dateOfJoining,
  employeeCode,
  activationUrl,
  expiresAt,
  letterFilename,
  timeZone,
}) {
  const firstName = candidateName.split(/\s+/)[0];
  const joiningText = dateOfJoining.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const expiryText = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(expiresAt);
  const passwordHint = `Your offer letter is attached (${letterFilename}). It is password-protected: the password is your date of birth written ${OFFER_LETTER_PROTECTION.PASSWORD_FORMAT_LABEL} (for 5 March 1996, 05031996).`;
  const footerText =
    "If you weren't expecting this offer, you can ignore this email; nothing happens unless the link is used.";
  const text = [
    `Hi ${firstName},`,
    '',
    `We are delighted to offer you the position of ${designation} at ${companyName}, joining on ${joiningText}.`,
    employeeCode ? `Your employee ID will be ${employeeCode}.` : null,
    '',
    passwordHint,
    '',
    'To accept, activate your account here:',
    activationUrl,
    '',
    `This link works until ${expiryText}.`,
    footerText,
  ]
    .filter((line) => line !== null)
    .join('\n');
  const html = renderEmailLayout({
    companyName,
    heading: `Your offer from ${companyName}`,
    bodyHtml: [
      paragraph(`Hi ${escapeHtml(firstName)},`),
      paragraph(
        `We are delighted to offer you the position of <strong>${escapeHtml(designation)}</strong> at <strong>${escapeHtml(companyName)}</strong>, joining on <strong>${escapeHtml(joiningText)}</strong>.`,
      ),
      employeeCode ? paragraph(`Your employee ID will be <strong>${escapeHtml(employeeCode)}</strong>.`) : '',
      paragraph(escapeHtml(passwordHint)),
    ].join(''),
    action: {
      label: 'Accept and activate my account',
      url: activationUrl,
      noteHtml: `This link works until ${escapeHtml(expiryText)}.`,
    },
    footerText,
  });
  return { subject: `Your offer from ${companyName}: ${designation}`, html, text };
}
