/**
 * Emails (services/emailLayout.js and the messages built on it): every value is escaped, and each
 * email has a working button, a copyable fallback link and a plain-text version.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMAIL_THEME, renderEmailLayout } from '../../services/emailLayout.js';
import { buildInvitationEmail } from '../../services/invitationEmail.js';
import { buildApprovalNeededEmail, buildDecisionEmail } from '../../services/leaveRequestEmails.js';
import { escapeHtml } from '../../utils/html.js';

const HOSTILE_TEXT = '<img src=x onerror=alert(1)> & "quoted" \'single\'';

describe('escapeHtml', () => {
  it('escapes every character that could break out of content or an attribute', () => {
    assert.equal(
      escapeHtml(HOSTILE_TEXT),
      '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot; &#39;single&#39;',
    );
    assert.equal(escapeHtml(null), '');
  });
});

describe('renderEmailLayout', () => {
  it('escapes the text values it is given and keeps the body HTML as built by the caller', () => {
    const html = renderEmailLayout({
      companyName: HOSTILE_TEXT,
      heading: HOSTILE_TEXT,
      bodyHtml: '<p>Body</p>',
      action: { label: HOSTILE_TEXT, url: 'https://hr.example.com/a?x=1&y="2"' },
      footerText: HOSTILE_TEXT,
    });
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<p>Body</p>'), true);
    assert.equal(html.includes('href="https://hr.example.com/a?x=1&amp;y=&quot;2&quot;"'), true);
    assert.equal(html.includes(EMAIL_THEME.ACCENT), true);
  });

  it('leaves out the button block when there is no action', () => {
    const html = renderEmailLayout({
      companyName: 'Nova',
      heading: 'Hi',
      bodyHtml: '<p>Body</p>',
      footerText: 'Footer',
    });
    assert.equal(html.includes('<a href'), false);
    assert.equal(html.includes("If the button doesn't work"), false);
  });
});

describe('buildInvitationEmail', () => {
  const details = {
    inviteeName: 'Kiran <b>Patel</b>',
    inviterName: 'Hema Rao',
    companyName: 'Nova Labs',
    designation: 'Engineer',
    departmentName: 'Platform',
    inviteUrl: 'https://hr.example.com/invite/abc_DEF-123',
    expiresAt: new Date('2026-11-03T10:00:00Z'),
  };

  it('addresses the invitee and links to the invitation, in HTML and plain text', () => {
    const email = buildInvitationEmail(details);
    assert.equal(email.subject, 'Hema Rao invited you to join Nova Labs');
    assert.equal(email.html.includes('Kiran &lt;b&gt;Patel&lt;/b&gt;'), true);
    assert.equal(email.html.includes('<b>Patel</b>'), false);
    assert.equal(email.html.split(details.inviteUrl).length - 1, 2, 'button and fallback link');
    assert.equal(email.html.includes('Activate my account'), true);
    assert.match(email.text, /Engineer, Platform/);
    assert.equal(email.text.includes(details.inviteUrl), true);
    assert.match(email.text, /expires on 3 November 2026/);
  });

  it('omits the department when there is none', () => {
    const email = buildInvitationEmail({ ...details, departmentName: null });
    assert.match(email.text, /join Nova Labs as Engineer\./);
  });
});

describe('leave request emails', () => {
  const hostile = '<script>x</script>';
  const request = {
    employeeName: `Asha ${hostile}`,
    leaveTypeName: 'Earned Leave',
    startDate: '2026-11-06',
    endDate: '2026-11-09',
    totalDays: 4,
    companyName: 'Nova Labs',
  };

  it('asks the approver to review a request, escaping what the employee wrote', () => {
    const email = buildApprovalNeededEmail({
      ...request,
      approverName: 'Ravi',
      reason: `Wedding ${hostile}`,
      changeKind: null,
      newEndDate: null,
      reviewUrl: 'https://hr.example.com/leave/approvals',
    });
    assert.equal(email.html.includes('<script>'), false);
    assert.equal(email.html.includes('&lt;script&gt;'), true);
    assert.match(email.text, /asked for Earned Leave, 6 Nov 2026 to 9 Nov 2026 \(4 days\)/);
    assert.match(email.text, /Reason: Wedding/);
    assert.equal(email.html.split('https://hr.example.com/leave/approvals').length - 1, 2, 'button and fallback link');
  });

  it('describes a change request by its kind', () => {
    const base = { ...request, approverName: 'Ravi', reason: 'Back early', reviewUrl: 'https://hr.example.com/x' };
    assert.match(
      buildApprovalNeededEmail({ ...base, changeKind: 'SHORTEN', newEndDate: '2026-11-07' }).text,
      /asked to end their Earned Leave \(6 Nov 2026 to 9 Nov 2026\) on 7 Nov 2026/,
    );
    assert.match(buildApprovalNeededEmail({ ...base, changeKind: 'CANCEL', newEndDate: null }).subject, /Leave change/);
  });

  it('tells the employee the outcome, with the note when there is one', () => {
    const approved = buildDecisionEmail({
      ...request,
      startDate: '2026-11-06',
      endDate: '2026-11-06',
      totalDays: 1,
      isApproved: true,
      isChange: false,
      deciderName: 'Ravi',
      note: null,
      viewUrl: 'https://hr.example.com/leave',
    });
    assert.equal(approved.subject, 'Your leave request was approved');
    assert.match(approved.text, /Ravi approved your leave request: Earned Leave, 6 Nov 2026 \(1 day\)/);
    assert.equal(approved.text.includes('Note:'), false);
    const declined = buildDecisionEmail({
      ...request,
      isApproved: false,
      isChange: true,
      deciderName: 'Ravi',
      note: `Busy week ${hostile}`,
      viewUrl: 'https://hr.example.com/leave',
    });
    assert.equal(declined.subject, 'Your leave change request was declined');
    assert.equal(declined.html.includes('<script>'), false);
    assert.match(declined.text, /Note: Busy week/);
  });
});
