/**
 * HR sets up the workplace and leave: an office with 2nd and 4th Saturdays off, a holiday, the
 * employee's base office; then a leave type, an entitlement for the employee, a refused
 * encashment, the payroll export and the balance check. One sign-in, because HR's logins are
 * limited per account and the other suites use HR too.
 */

import { expect, test } from '@playwright/test';

import { ACCOUNTS, EMPLOYEE } from './environment.js';
import { signIn, watchForPageProblems } from './helpers.js';

const OFFICE = Object.freeze({ name: 'Bengaluru HQ', code: 'BLR-HQ' });

test('HR sets up an office, a holiday and leave, and manages an employee’s balance', async ({ page }) => {
  test.setTimeout(90_000);
  const problems = watchForPageProblems(page);
  await signIn(page, ACCOUNTS.hr.email);

  // --- Workplace: an office, its weekly offs, a holiday, the employee's office -------------------
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Workplace' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Workplace' })).toBeVisible();

  await page.getByRole('button', { name: 'Add office' }).click();
  await page.getByLabel('Office name').fill(OFFICE.name);
  await page.getByLabel('Office code').fill(OFFICE.code);
  await page.getByLabel('Latitude').fill('12.9716');
  await page.getByLabel('Longitude').fill('77.5946');
  await page.getByLabel('Shift starts').fill('09:30');
  await page.getByLabel('Shift ends').fill('18:30');
  await page.getByRole('button', { name: 'Add office' }).last().click();

  const officeRow = page.getByRole('listitem').filter({ hasText: OFFICE.code });
  await expect(officeRow.getByText('Saturday', { exact: true })).toBeVisible();
  await expect(officeRow.getByText('Sunday', { exact: true })).toBeVisible();

  await officeRow.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Saturday schedule').selectOption({ label: 'Off on some weeks' });
  await expect(page.getByRole('group', { name: 'Which Saturdays are off' }).getByLabel('2nd')).toBeChecked();
  await page.getByRole('button', { name: 'Save office' }).click();
  await expect(officeRow.getByText('Saturday (2nd and 4th)')).toBeVisible();

  const year = new Date().getFullYear();
  await page.getByRole('tab', { name: 'Holidays' }).click();
  await page.getByRole('button', { name: 'Add holiday' }).click();
  await page.getByLabel('Holiday name').fill('Founders Day');
  await page.getByLabel('Date').fill(`${year}-08-14`);
  await page.getByRole('button', { name: 'Add holiday' }).last().click();
  const holidayRow = page.getByRole('listitem').filter({ hasText: 'Founders Day' });
  await expect(holidayRow.getByText('Every office')).toBeVisible();

  await page.getByRole('tab', { name: 'Employees' }).click();
  const employeeRow = page.getByRole('listitem').filter({ hasText: EMPLOYEE.email });
  await expect(employeeRow.getByText('No office', { exact: true }).first()).toBeVisible();
  await employeeRow.getByLabel(`Base office for ${EMPLOYEE.name}`).selectOption({ label: OFFICE.name });
  await expect(employeeRow.locator('span', { hasText: /^No office$/ })).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: 'Employees' }).click();
  await expect(page.getByLabel(`Base office for ${EMPLOYEE.name}`)).toHaveValue(/[0-9a-f]{24}/);

  // --- Leave administration: a type, an entitlement, a refused encashment -------------------------
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Leave admin' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Leave administration' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Earned Leave' })).toBeVisible();
  // The stored zone shows even though Chromium lists it only as Asia/Calcutta.
  await expect(page.getByLabel('Default time zone')).toHaveValue('Asia/Kolkata');

  await page.getByRole('button', { name: 'Add leave type' }).click();
  await page.getByLabel('Code').fill('STUDY');
  await page.getByLabel('Name', { exact: true }).fill('Study Leave');
  await page.getByRole('button', { name: 'Add leave type' }).last().click();
  const studyRow = page.getByRole('listitem').filter({ hasText: 'Study Leave' });
  await expect(studyRow.getByText('Granted per person by HR')).toBeVisible();

  await page.getByRole('tab', { name: 'Balances' }).click();
  await page.getByLabel('Employee', { exact: true }).selectOption({ label: `${EMPLOYEE.name} · Analyst` });
  await page.getByRole('button', { name: 'Adjust balance' }).click();
  await page.getByLabel('Leave type').selectOption({ label: 'STUDY · Study Leave' });
  await page.getByLabel('Kind').selectOption('ENTITLEMENT_GRANT');
  await page.getByLabel('Days').fill('5');
  await page.getByLabel('Note').fill('Exam preparation');
  await page.getByRole('button', { name: 'Post adjustment' }).click();
  await expect(page.getByText('Balance adjusted')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Entitlement granted' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Exam preparation' })).toBeVisible();

  // Earned Leave keeps 15 days after any encashment and she has none, so payroll gets nothing.
  await page.getByRole('button', { name: 'Encash days' }).click();
  await page.getByLabel('Leave type').selectOption({ label: 'EL · Earned Leave' });
  await page.getByLabel('Days').fill('1');
  await page.getByLabel('Payroll reference').fill('PAY-E2E-001');
  await page.getByRole('button', { name: 'Record encashment' }).click();
  await expect(page.getByText('Encashing this many days would leave less than the policy keeps')).toBeVisible();

  await page.getByRole('tab', { name: 'Payroll' }).click();
  await page.getByRole('button', { name: 'Show figures' }).click();
  await expect(page.getByText('Nothing for payroll this month')).toBeVisible();

  await page.getByRole('tab', { name: 'Maintenance' }).click();
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByText('Balances checked', { exact: true })).toBeVisible();

  expect(problems, problems.join('\n')).toEqual([]);
});
