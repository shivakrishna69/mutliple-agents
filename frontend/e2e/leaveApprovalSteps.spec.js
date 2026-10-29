/**
 * Two-step approval in the browser, on the employee global setup prepares whose Earned Leave needs
 * HR's approval after the manager's: the employee sees both steps waiting, the manager approves
 * the first, an administrator (deciding for HR) who still had the old queue open is told someone
 * got there first, then approves the HR step, and the employee sees the leave approved.
 *
 * The administrator decides the HR step because HR's own logins are kept for the other tests.
 */

import { expect, test } from '@playwright/test';

import { ACCOUNTS, LEAVE_MANAGER, TWO_STEP_EARNED_DAYS, TWO_STEP_EMPLOYEE } from './environment.js';
import { signIn, watchForPageProblems } from './helpers.js';

// The browser keeps the office's time zone, so "today" matches the employee's.
test.use({ timezoneId: 'Asia/Kolkata' });

test('long leave is approved by the manager, then by HR', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const problems = watchForPageProblems(page);

  // --- The employee asks for a day of Earned Leave ------------------------------------------------
  await signIn(page, TWO_STEP_EMPLOYEE.email);
  await page.goto('/leave');
  await page.getByRole('button', { name: 'Ask for leave' }).click();
  await page.getByLabel('Leave type').selectOption({ label: 'Earned Leave (EL)' });
  await expect(page.getByText('This leave costs 1 day')).toBeVisible();
  await page.getByLabel('Reason').fill('Family wedding');
  await page.getByRole('button', { name: 'Send request' }).click();
  const requestRow = page.getByRole('listitem').filter({ hasText: 'Family wedding' });
  await expect(requestRow.getByText('Waiting for the manager, then HR')).toBeVisible();

  // --- The administrator opens the queue, then the manager approves the first step ----------------
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, ACCOUNTS.admin.email);
  await adminPage.goto('/leave/approvals');
  const adminItem = adminPage.getByRole('listitem').filter({ hasText: TWO_STEP_EMPLOYEE.name });
  await expect(adminItem.getByText('Waiting for the manager, then HR')).toBeVisible();

  const managerContext = await browser.newContext();
  const managerPage = await managerContext.newPage();
  await signIn(managerPage, LEAVE_MANAGER.email);
  await managerPage.goto('/leave/approvals');
  const managerItem = managerPage.getByRole('listitem').filter({ hasText: TWO_STEP_EMPLOYEE.name });
  await managerItem.getByRole('button', { name: 'Approve' }).click();
  await expect(
    managerPage.getByText(`${TWO_STEP_EMPLOYEE.name}’s request was approved; it now needs HR’s approval`),
  ).toBeVisible();
  await expect(managerPage.getByText('Nothing waiting')).toBeVisible();
  await managerContext.close();

  await page.reload();
  await expect(requestRow.getByText('Manager approved · waiting for HR')).toBeVisible();
  await expect(requestRow.getByText('Waiting for approval')).toBeVisible();

  // --- The administrator's click was for the manager's step, so it is refused and the queue reloads
  await adminItem.getByRole('button', { name: 'Approve' }).click();
  await expect(adminPage.getByText('Someone decided this step a moment ago')).toBeVisible();
  await expect(adminItem.getByText('Manager approved · waiting for HR')).toBeVisible();

  // --- The administrator approves the HR step, which charges the leave ----------------------------
  await adminItem.getByRole('button', { name: 'Approve' }).click();
  await expect(adminPage.getByText(`${TWO_STEP_EMPLOYEE.name}’s request was approved`)).toBeVisible();
  await expect(adminItem).toHaveCount(0);
  await adminContext.close();

  await page.reload();
  await expect(requestRow.getByText('Approved', { exact: true })).toBeVisible();
  await expect(requestRow.getByText('waiting for HR')).toHaveCount(0);
  const earnedCard = page.getByText('Earned Leave', { exact: true }).locator('xpath=../../..');
  await expect(earnedCard.getByText(`${TWO_STEP_EARNED_DAYS - 1} days`, { exact: true })).toBeVisible();

  expect(problems, problems.join('\n')).toEqual([]);
});
