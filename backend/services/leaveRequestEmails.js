/**
 * Leave request emails: the approver hears about a new request or change request, and the employee
 * hears about each decision. Built on the shared layout (services/emailLayout.js) with a plain-text
 * version; every interpolated value is escaped.
 *
 * Sending never fails the request it follows: without email configured nothing is sent, and a
 * delivery failure is logged by services/mailService.js. A request in HR's queue (no reporting
 * manager) sends no submission email; HR works from the queue.
 */

import EmployeeProfile from '../models/EmployeeProfile.js';
import User from '../models/User.js';
import { escapeHtml } from '../utils/html.js';
import { logger } from '../utils/logger.js';
import { renderEmailLayout } from './emailLayout.js';
import { sendMail } from './mailService.js';

/** Pages of the web app the emails link to. */
export const LEAVE_APP_PATHS = Object.freeze({ MY_LEAVE: '/leave', APPROVALS: '/leave/approvals' });

const DATE_FORMAT = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const formatDate = (calendarDate) => DATE_FORMAT.format(new Date(`${calendarDate}T00:00:00Z`));

const formatDays = (days) => `${days} ${days === 1 ? 'day' : 'days'}`;

function describeDates({ startDate, endDate }) {
  return startDate === endDate ? formatDate(startDate) : `${formatDate(startDate)} to ${formatDate(endDate)}`;
}

const paragraph = (html) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">${html}</p>`;

/**
 * To the approver: a request (or a change to approved leave) is waiting.
 * @param {{ approverName: string, employeeName: string, leaveTypeName: string, startDate: string,
 *   endDate: string, totalDays: number, reason: string, changeKind: 'CANCEL'|'SHORTEN'|null,
 *   newEndDate: string|null, companyName: string, reviewUrl: string }} details
 */
export function buildApprovalNeededEmail({
  approverName,
  employeeName,
  leaveTypeName,
  startDate,
  endDate,
  totalDays,
  reason,
  changeKind,
  newEndDate,
  companyName,
  reviewUrl,
}) {
  const dates = describeDates({ startDate, endDate });
  let summary = `${employeeName} has asked for ${leaveTypeName}, ${dates} (${formatDays(totalDays)}).`;
  if (changeKind === 'CANCEL') summary = `${employeeName} has asked to cancel their ${leaveTypeName}, ${dates}.`;
  if (changeKind === 'SHORTEN') {
    summary = `${employeeName} has asked to end their ${leaveTypeName} (${dates}) on ${formatDate(newEndDate)}.`;
  }
  const subject = changeKind
    ? `Leave change to review: ${employeeName}`
    : `Leave request to review: ${employeeName}, ${dates}`;
  const footerText = 'You receive this because you approve leave for this employee.';
  const text = [
    `Hi ${approverName},`,
    '',
    summary,
    `Reason: ${reason}`,
    '',
    `Review it: ${reviewUrl}`,
    '',
    footerText,
  ].join('\n');
  const html = renderEmailLayout({
    companyName,
    heading: changeKind ? 'A leave change needs your decision' : 'A leave request needs your decision',
    bodyHtml: [
      paragraph(`Hi ${escapeHtml(approverName)},`),
      paragraph(escapeHtml(summary)),
      paragraph(`<strong>Reason:</strong> ${escapeHtml(reason)}`),
    ].join('\n'),
    action: { label: 'Review', url: reviewUrl },
    footerText,
  });
  return { subject, html, text };
}

/**
 * To the employee: their request (or change) was decided.
 * @param {{ employeeName: string, leaveTypeName: string, startDate: string, endDate: string,
 *   totalDays: number, isApproved: boolean, isChange: boolean, deciderName: string, note: string|null,
 *   companyName: string, viewUrl: string }} details
 */
export function buildDecisionEmail({
  employeeName,
  leaveTypeName,
  startDate,
  endDate,
  totalDays,
  isApproved,
  isChange,
  deciderName,
  note,
  companyName,
  viewUrl,
}) {
  const outcome = isApproved ? 'approved' : 'declined';
  const subjectOf = isChange ? 'leave change request' : 'leave request';
  const subject = `Your ${subjectOf} was ${outcome}`;
  const summary = `${deciderName} ${outcome} your ${subjectOf}: ${leaveTypeName}, ${describeDates({ startDate, endDate })} (${formatDays(totalDays)}).`;
  const footerText = 'You receive this because you asked for this leave.';
  const text = [
    `Hi ${employeeName},`,
    '',
    summary,
    ...(note ? [`Note: ${note}`] : []),
    '',
    viewUrl,
    '',
    footerText,
  ].join('\n');
  const html = renderEmailLayout({
    companyName,
    heading: `Your ${subjectOf} was ${outcome}`,
    bodyHtml: [
      paragraph(`Hi ${escapeHtml(employeeName)},`),
      paragraph(escapeHtml(summary)),
      ...(note ? [paragraph(`<strong>Note:</strong> ${escapeHtml(note)}`)] : []),
    ].join('\n'),
    action: { label: 'View my leave', url: viewUrl },
    footerText,
  });
  return { subject, html, text };
}

/** { name, email } of an employee's account, or null. */
async function contactOfEmployee(employeeId) {
  if (!employeeId) return null;
  const profile = await EmployeeProfile.findById(employeeId).select('userId').lean();
  if (!profile) return null;
  return User.findById(profile.userId).select('name email').lean();
}

async function deliver(buildEmail, recipient) {
  if (!recipient?.email) return;
  await sendMail({ to: recipient.email, ...buildEmail(recipient) });
}

/** Never throws: an email is a courtesy, not part of the change. */
async function safely(task) {
  try {
    await task();
  } catch (emailError) {
    logger.error('Leave email could not be prepared', {
      error: { name: emailError.name, message: emailError.message },
    });
  }
}

/**
 * Tells the approver a request (or change request) is waiting.
 * @param {object} request  a request summary (services/leaveRequests.js)
 * @param {{ companyName: string, appPublicUrl: string }} appContext
 */
export function notifyApproverOfRequest(request, appContext) {
  return safely(async () => {
    const approver = await contactOfEmployee(request.approverEmployeeId);
    await deliver(
      (recipient) =>
        buildApprovalNeededEmail({
          approverName: recipient.name,
          employeeName: request.employee.name,
          leaveTypeName: request.leaveType.name,
          startDate: request.startDate,
          endDate: request.endDate,
          totalDays: request.totalDays,
          reason: request.pendingChange?.reason ?? request.reason,
          changeKind: request.pendingChange?.kind ?? null,
          newEndDate: request.pendingChange?.newEndDate ?? null,
          companyName: appContext.companyName,
          reviewUrl: `${appContext.appPublicUrl}${LEAVE_APP_PATHS.APPROVALS}`,
        }),
      approver,
    );
  });
}

/**
 * Tells the employee their request (or change request) was decided.
 * @param {object} request  the request summary after the decision
 * @param {{ isApproved: boolean, isChange: boolean, deciderName: string, note: string|null }} decision
 * @param {{ companyName: string, appPublicUrl: string }} appContext
 */
export function notifyEmployeeOfDecision(request, { isApproved, isChange, deciderName, note }, appContext) {
  return safely(async () => {
    const employee = await contactOfEmployee(request.employee.id);
    await deliver(
      (recipient) =>
        buildDecisionEmail({
          employeeName: recipient.name,
          leaveTypeName: request.leaveType.name,
          startDate: request.startDate,
          endDate: request.endDate,
          totalDays: request.totalDays,
          isApproved,
          isChange,
          deciderName,
          note,
          companyName: appContext.companyName,
          viewUrl: `${appContext.appPublicUrl}${LEAVE_APP_PATHS.MY_LEAVE}`,
        }),
      employee,
    );
  });
}
