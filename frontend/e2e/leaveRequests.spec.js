/**
 * The leave cycle in the browser, on the scenario global setup prepares (an employee at an office
 * open every day, with Casual Leave, reporting to a manager): the employee sees the price of a
 * day's leave before sending it, the manager approves it, the employee asks to cancel it once it
 * has started, the manager declines with a note, and the calendar shows the leave.
 *
 * The leave is booked for today, which is always a working day at that office and inside the
 * current leave year, so the test gives the same result whenever it runs.
 */

import { expect, test } from '@playwright/test';

import { LEAVE_EMPLOYEE, LEAVE_EMPLOYEE_CASUAL_DAYS, LEAVE_MANAGER } from './environment.js';
import { signIn, watchForPageProblems } from './helpers.js';

// The browser keeps the office's time zone, so its month and today match the employee's.
test.use({ timezoneId: 'Asia/Kolkata' });

test('an employee asks for leave, the manager approves it and declines a change', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const problems = watchForPageProblems(page);

  // --- The employee asks for a day of Casual Leave ------------------------------------------------
  await signIn(page, LEAVE_EMPLOYEE.email);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Leave' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Leave' })).toBeVisible();
  const casualCard = page.getByText('Casual Leave', { exact: true }).locator('xpath=../../..');
  await expect(casualCard.getByText(`${LEAVE_EMPLOYEE_CASUAL_DAYS} days`, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Ask for leave' }).click();
  await page.getByLabel('Leave type').selectOption({ label: 'Casual Leave (CL)' });
  await expect(page.getByText('This leave costs 1 day')).toBeVisible();
  await expect(
    page.getByText(`${LEAVE_EMPLOYEE_CASUAL_DAYS} days available · ${LEAVE_EMPLOYEE_CASUAL_DAYS - 1} days left after`),
  ).toBeVisible();
  await page.getByLabel('Which part of the day').selectOption({ label: 'Morning only (first half)' });
  await expect(page.getByText('This leave costs 0.5 days')).toBeVisible();
  await page.getByLabel('Which part of the day').selectOption({ label: 'Full day' });
  await expect(page.getByText('This leave costs 1 day')).toBeVisible();
  await page.getByLabel('Reason').fill('Visiting the bank');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Your manager has been told and will decide it.')).toBeVisible();
  const requestRow = page.getByRole('listitem').filter({ hasText: 'Visiting the bank' });
  await expect(requestRow.getByText('Waiting for approval')).toBeVisible();
  await expect(casualCard.getByText('1 day held')).toBeVisible();

  // --- The manager approves it --------------------------------------------------------------------
  const managerContext = await browser.newContext();
  const managerPage = await managerContext.newPage();
  await signIn(managerPage, LEAVE_MANAGER.email);
  await managerPage.goto('/leave/approvals');
  const approvalItem = managerPage.getByRole('listitem').filter({ hasText: LEAVE_EMPLOYEE.name });
  await expect(approvalItem.getByText('“Visiting the bank”', { exact: false })).toBeVisible();
  await approvalItem.getByRole('button', { name: 'Approve' }).click();
  await expect(managerPage.getByText(`${LEAVE_EMPLOYEE.name}’s request was approved`)).toBeVisible();
  await expect(managerPage.getByText('Nothing waiting')).toBeVisible();

  // --- The leave has started, so the employee asks to cancel it; the manager declines --------------
  await page.reload();
  await expect(requestRow.getByText('Approved', { exact: true })).toBeVisible();
  await requestRow.getByRole('button', { name: 'End early or cancel' }).click();
  await requestRow.getByLabel('Change').selectOption({ label: 'Cancel the rest of it' });
  await requestRow.getByLabel('Why').fill('The bank visit was moved');
  await requestRow.getByRole('button', { name: 'Send for approval' }).click();
  await expect(requestRow.getByText('You asked to cancel the rest of this leave')).toBeVisible();

  await managerPage.reload();
  await managerPage.getByRole('tab', { name: 'Changes to leave' }).click();
  const changeItem = managerPage.getByRole('listitem').filter({ hasText: 'The bank visit was moved' });
  const declineButton = changeItem.getByRole('button', { name: 'Decline' });
  await expect(declineButton, 'declining needs a note').toBeDisabled();
  await changeItem.getByLabel('Note (needed to decline)').fill('Please take the day as planned');
  await declineButton.click();
  await expect(managerPage.getByText(`${LEAVE_EMPLOYEE.name}’s change was declined`)).toBeVisible();
  await managerContext.close();

  await page.reload();
  await expect(requestRow.getByText('Approved', { exact: true })).toBeVisible();
  await expect(requestRow.getByText('You asked to cancel')).toHaveCount(0);

  // --- The calendar shows the approved leave ------------------------------------------------------
  await page.getByRole('tab', { name: 'Calendar' }).click();
  await expect(page).toHaveURL(/\/leave\/calendar$/);
  await expect(page.getByText('Working days at E2E Office')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: /^\d+CL$/ })).toHaveCount(1);

  expect(problems, problems.join('\n')).toEqual([]);
});
