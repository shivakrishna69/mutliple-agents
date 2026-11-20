/**
 * The Form 16 portal in the browser, against the real backend with the S3 stand-in:
 *   - a chartered accountant signs in and lands on the CA portal, sees only the CA portal and
 *     Account in the sidebar, and is sent back there from the employee workspace;
 *   - the employee above ₹12,00,000 is listed and the one exactly at it is not, even by search;
 *   - the CA uploads a Form 16 PDF with a computation summary for the eligible employee;
 *   - that employee opens Payroll → Form 16 and downloads it; the employee at the threshold sees the
 *     note that Form 16 here applies above it.
 * Accounts and CTCs come from global setup (environment.js FORM16_*).
 */

import { expect, test } from '@playwright/test';

import { FORM16_ABOVE, FORM16_AT, FORM16_CA } from './environment.js';
import { mainNavigation, signIn, watchForPageProblems } from './helpers.js';

const PDF = Buffer.from('%PDF-1.7\n% Form 16 for the browser test\n%%EOF\n', 'latin1');

test.describe.configure({ mode: 'serial' });

test('a CA uploads a Form 16 for an employee above ₹12,00,000 only', async ({ page }) => {
  const problems = watchForPageProblems(page);
  await signIn(page, FORM16_CA.email, undefined, { landsOn: /\/tax\/ca-portal$/ });
  await expect(page.getByRole('heading', { name: 'Form 16 / CA Portal' })).toBeVisible();

  await expect(mainNavigation(page).getByRole('link')).toHaveText(['Form 16 / CA Portal', 'Account']);
  await page.goto('/payroll');
  await expect(page).toHaveURL(/\/tax\/ca-portal$/);

  const rows = page.getByTestId('ca-employee-row');
  await expect(rows.filter({ hasText: FORM16_ABOVE.name })).toHaveCount(1);
  await expect(rows.filter({ hasText: FORM16_AT.name })).toHaveCount(0);
  await page.getByLabel('Search employees').fill(FORM16_AT.name);
  await expect(page.getByText('No employees to show')).toBeVisible();
  await page.getByLabel('Search employees').fill('');

  const row = rows.filter({ hasText: FORM16_ABOVE.name });
  await expect(row.getByText('Pending')).toBeVisible();
  await row.getByRole('button', { name: 'Upload' }).click();
  const dialog = page.getByTestId('form16-upload-dialog');
  await expect(dialog.getByTestId('form16-annual-ctc')).toHaveText('₹18,00,000');
  await dialog
    .getByLabel('Form 16 PDF')
    .setInputFiles({ name: 'form16.pdf', mimeType: 'application/pdf', buffer: PDF });
  await dialog.getByLabel('TDS deducted').fill('152400');
  await dialog.getByLabel('Tax regime').selectOption('new');
  await dialog.getByLabel('CA remarks').fill('Checked against Form 26AS');
  await dialog.getByRole('button', { name: 'Upload Form 16' }).click();
  await expect(dialog.getByText('Version 1 uploaded')).toBeVisible();
  await expect(dialog.getByTestId('form16-history')).toContainText('v1 · Part A + Part B');
  await page.keyboard.press('Escape');
  await expect(row.getByText('Uploaded')).toBeVisible();
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the employee downloads their Form 16; the one at ₹12,00,000 is told it does not apply', async ({ browser }) => {
  const aboveContext = await browser.newContext();
  const page = await aboveContext.newPage();
  await signIn(page, FORM16_ABOVE.email);
  await page.goto('/payroll');
  await page.getByRole('tab', { name: 'Form 16' }).click();
  const panel = page.getByTestId('my-form16');
  await expect(panel.getByText('Checked against Form 26AS')).toBeVisible();
  await expect(panel.getByText('₹1,52,400.00')).toBeVisible();
  // The signed link opens in a new tab (noopener, so watched from the browser context): it fetches the
  // stored Form 16 from S3.
  const fileRequest = page.context().waitForEvent('request', (request) => request.url().includes('company-tax-docs/'));
  await panel.getByRole('button', { name: 'Download Form 16 PDF' }).click();
  expect((await fileRequest).url()).toMatch(/company-tax-docs\/form16\/\d{4}-\d{2}\/[0-9a-f]{24}\/[0-9a-f]{24}\.pdf/);
  await aboveContext.close();

  const atContext = await browser.newContext();
  const atPage = await atContext.newPage();
  await signIn(atPage, FORM16_AT.email);
  await atPage.goto('/payroll');
  await atPage.getByRole('tab', { name: 'Form 16' }).click();
  await expect(atPage.getByTestId('my-form16').getByText(/annual CTC is above ₹12,00,000/)).toBeVisible();
  await expect(atPage.getByRole('button', { name: 'Download Form 16 PDF' })).toHaveCount(0);
  await atContext.close();
});
