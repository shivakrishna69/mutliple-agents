/**
 * The daily briefing in two browsers. The manager waits on My Access; their report asks for leave and
 * the manager's briefing bar, ✦ pill and Leave badge update live (INSIGHTS_CHANGED), without a
 * reload. The manager opens the briefing: the leave card shows the balance, the leave taken and the
 * team overlap, with Ask NSK prepared (not sent). Approve can be undone; the second Approve is sent and
 * the card leaves. A second request is declined with a reason from the panel. Overview shows the bar
 * below the greeting. Everything it asks for is decided again, so the manager's queue is empty for
 * the leave tests that follow.
 */

import { expect, test } from '@playwright/test';

import { BRIEFING_EMPLOYEE, BRIEFING_EMPLOYEE_CASUAL_DAYS, LEAVE_MANAGER } from './environment.js';
import { signIn, watchForPageProblems } from './helpers.js';

// Its own client address (sign-ins stay out of the shared per-IP budget), in the office's time zone.
test.use({ timezoneId: 'Asia/Kolkata', extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.71' } });

const COMPANY_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const inDays = (days) => COMPANY_DATE.format(new Date(Date.now() + days * 86_400_000));

async function askForLeave(page, { from, to, reason }) {
  await page.goto('/leave');
  await page.getByRole('button', { name: 'Ask for leave' }).click();
  await page.getByLabel('Leave type').selectOption({ label: 'Casual Leave (CL)' });
  await page.getByLabel('From').fill(from);
  await page.getByLabel('To').fill(to);
  await page.getByLabel('Reason').fill(reason);
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Your manager has been told and will decide it.')).toBeVisible();
}

test('a manager sees leave arrive in the briefing live, approves with undo, and declines with a reason', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const problems = watchForPageProblems(page);
  await signIn(page, LEAVE_MANAGER.email, undefined, { stayOnLauncher: true });
  const bar = page.getByTestId('briefing-bar');
  const pill = page.getByRole('banner').getByTestId('insights-pill');
  const leaveBadge = page.getByTestId('my-access-tile').filter({ hasText: 'Leave' }).getByTestId('my-access-badge');
  await expect(bar.getByTestId('briefing-headline')).toHaveText('Nothing needs you right now');
  await expect(pill).toHaveCount(0);
  await expect(leaveBadge).toHaveCount(0);

  // --- The report asks for two days; the manager's page updates without a reload -------------------
  const employeeContext = await browser.newContext({
    timezoneId: 'Asia/Kolkata',
    extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.71' },
  });
  const employeePage = await employeeContext.newPage();
  await signIn(employeePage, BRIEFING_EMPLOYEE.email);
  await askForLeave(employeePage, { from: inDays(30), to: inDays(31), reason: 'Sister’s wedding' });

  await expect(bar.getByTestId('briefing-headline')).toHaveText('1 leave request to approve');
  await expect(bar.getByText(`Leave request: ${BRIEFING_EMPLOYEE.name}`)).toBeVisible();
  await expect(pill).toHaveAccessibleName('Briefing: 1 item');
  await expect(leaveBadge).toHaveText('1');

  // --- The briefing panel: what the decision needs --------------------------------------------------
  await pill.click();
  const panel = page.getByRole('dialog', { name: /Today’s briefing/ });
  const card = panel.getByTestId('insight-card').filter({ hasText: BRIEFING_EMPLOYEE.name });
  await expect(card.getByText(/\(2 days\) · Casual Leave/)).toBeVisible();
  await expect(
    card.getByText(`Balance: ${BRIEFING_EMPLOYEE_CASUAL_DAYS - 2} days left · 0 taken this year`),
  ).toBeVisible();
  await expect(card.getByText(/^(Team overlap: |No one else on the team is off then)/)).toBeVisible();
  const askNsk = card.getByRole('link', { name: 'Ask NSK' });
  expect(await askNsk.getAttribute('href')).toMatch(/^\/ask-nsk\?q=.+/);

  // Approve, then Undo: nothing is sent.
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card.getByText(/Approving…/)).toBeVisible();
  await card.getByRole('button', { name: 'Undo' }).click();
  await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible();

  // Approve for real: sent after the undo window; the card leaves and the pill goes.
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(panel.getByText(/Leave request approved/)).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId('insight-card')).toHaveCount(0);
  await expect(pill).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(bar.getByTestId('briefing-headline')).toHaveText('Nothing needs you right now');
  await expect(leaveBadge).toHaveCount(0);

  await employeePage.goto('/leave');
  await expect(
    employeePage.getByRole('listitem').filter({ hasText: 'Sister’s wedding' }).getByText('Approved', { exact: true }),
  ).toBeVisible();

  // --- A second request, declined from the panel with a reason -----------------------------------
  await askForLeave(employeePage, { from: inDays(40), to: inDays(40), reason: 'Long weekend' });
  await expect(pill).toHaveAccessibleName('Briefing: 1 item');
  await page.getByTestId('briefing-open').click();
  const secondCard = panel.getByTestId('insight-card').filter({ hasText: BRIEFING_EMPLOYEE.name });
  await secondCard.getByRole('button', { name: 'Decline' }).click();
  await expect(secondCard.getByRole('button', { name: 'Decline request' })).toBeDisabled();
  await secondCard.getByLabel('Reason for declining').fill('Release week, please pick another day');
  await secondCard.getByRole('button', { name: 'Decline request' }).click();
  await expect(panel.getByText(/Leave request rejected/)).toBeVisible();
  await expect(pill).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close briefing' }).click();

  // --- Overview carries the bar below the greeting ---------------------------------------------------
  await page.goto('/dashboard');
  await expect(page.getByTestId('briefing-bar').getByTestId('briefing-headline')).toHaveText(
    'Nothing needs you right now',
  );

  expect(problems, problems.join('\n')).toEqual([]);
  await employeeContext.close();
});
