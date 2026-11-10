/**
 * The email an employee receives when their department answers a question its agent could not:
 * built on the shared layout (services/emailLayout.js) with a plain-text version; every
 * interpolated value is escaped. Sending never fails the answer it follows: without email
 * configured nothing is sent, and a delivery failure is logged by services/mailService.js.
 */

import { escapeHtml } from '../../utils/html.js';
import { renderEmailLayout } from '../emailLayout.js';

const paragraph = (html) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">${html}</p>`;
const quote = (html) =>
  `<blockquote style="margin:0 0 14px;padding:10px 14px;border-left:3px solid #cbd5e1;color:#334155;font-size:15px;line-height:1.6;white-space:pre-wrap">${html}</blockquote>`;

/**
 * @param {{ employeeName: string, departmentName: string, leadName: string, question: string,
 *   answer: string, companyName: string, viewUrl: string }} details
 */
export function buildQuestionAnsweredEmail({
  employeeName,
  departmentName,
  leadName,
  question,
  answer,
  companyName,
  viewUrl,
}) {
  const subject = `${departmentName} answered your question`;
  const summary = `${leadName} from ${departmentName} answered the question you asked their agent.`;
  const footerText = `You receive this because you asked the ${departmentName} agent a question it could not answer.`;
  const text = [
    `Hi ${employeeName},`,
    '',
    summary,
    '',
    `Your question: ${question}`,
    '',
    'Their answer:',
    answer,
    '',
    `See it in the app: ${viewUrl}`,
    '',
    footerText,
  ].join('\n');
  const html = renderEmailLayout({
    companyName,
    heading: subject,
    bodyHtml: [
      paragraph(`Hi ${escapeHtml(employeeName)},`),
      paragraph(escapeHtml(summary)),
      paragraph('<strong>Your question</strong>'),
      quote(escapeHtml(question)),
      paragraph('<strong>Their answer</strong>'),
      quote(escapeHtml(answer)),
    ].join('\n'),
    action: { label: 'Open the conversation', url: viewUrl },
    footerText,
  });
  return { subject, html, text };
}
