/**
 * HR onboards people: one invitation by hand (activated from its link in another browser), then a
 * CSV import with a new department, a manager and their report, and a row with a problem. One
 * sign-in, because HR's logins are limited per account and the other suites use HR too.
 */

import { expect, test } from '@playwright/test';

import { ACCOUNTS, DEPARTMENT_NAME, PASSWORD } from './environment.js';
import { emailedLink, localToday, signIn, watchForPageProblems } from './helpers.js';

function importFile() {
  const today = localToday();
  const csv = [
    'name,personal_email,department_code,department_name,designation,manager_email,date_of_joining',
    `Omar Lead,omar.lead@example.com,OPS,Operations,Operations Lead,,${today}`,
    `Priya Ops,priya.ops@example.com,OPS,,Operations Analyst,omar.lead@example.com,${today}`,
    `Bad Row,not-an-email,OPS,,Analyst,,${today}`,
  ].join('\n');
  return { name: 'new-joiners.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) };
}

test('HR invites a new joiner, then imports more from a CSV', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const problems = watchForPageProblems(page);
  await signIn(page, ACCOUNTS.hr.email);
  await page.goto('/people/onboarding');

  // --- One invitation ----------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Invite someone' }).click();
  await page.getByLabel('Full name').fill('Nisha Kapoor');
  await page.getByLabel('Personal email').fill('nisha.kapoor@example.com');
  await page.getByLabel('Job title').fill('Support Engineer');
  await page.getByLabel('Department').selectOption({ label: DEPARTMENT_NAME });
  // Access and job level are grouped; HR is offered only the roles HR may grant.
  const groupLabels = (select) =>
    select.locator('optgroup').evaluateAll((groups) => groups.map((group) => group.label));
  const access = page.getByLabel('Access');
  expect(await groupLabels(access)).toEqual(['Support', 'General']);
  await expect(access.locator('option')).toHaveText(['Support Agent', 'Employee']);
  await expect(access).toHaveValue('employee');
  const jobLevel = page.getByLabel('Job level');
  expect(await groupLabels(jobLevel)).toEqual(['Executive', 'Management', 'Staff']);
  await expect(jobLevel).toHaveValue('individual_contributor');
  await jobLevel.selectOption({ label: 'Team Lead' });
  await page.getByLabel('Employment type').selectOption({ label: 'Contractor' });
  await page.getByRole('button', { name: 'Send invitation' }).click();

  // The invitation is emailed; the new joiner opens the link from their inbox.
  const inviteUrl = await emailedLink('nisha.kapoor@example.com', '/invite');
  const invitationRow = page.getByRole('listitem').filter({ hasText: 'nisha.kapoor@example.com' });
  await expect(invitationRow.getByText(/^NSK\d{4}$/)).toBeVisible();
  await expect(invitationRow.getByText(/Support Engineer · Team Lead · Contractor/)).toBeVisible();
  await expect(invitationRow.getByText('Employee', { exact: true })).toBeVisible();

  // The new joiner opens the link in their own browser (no shared cookies with HR).
  const joinerContext = await browser.newContext();
  const joinerPage = await joinerContext.newPage();
  await joinerPage.goto(inviteUrl);
  await expect(joinerPage.getByRole('heading', { level: 1 })).toContainText('Nisha');
  await expect(joinerPage.getByText('nisha.kapoor@example.com')).toBeVisible();
  await expect(joinerPage.getByText(`Support Engineer, ${DEPARTMENT_NAME}`)).toBeVisible();
  await joinerPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await joinerPage.getByLabel('Confirm password').fill(PASSWORD);
  // The terms must be agreed to: the server refuses the activation otherwise, under the checkbox.
  await joinerPage.getByRole('button', { name: 'Activate my account' }).click();
  await expect(joinerPage.locator('#acceptTerms-error')).toBeVisible();
  await joinerPage.getByRole('checkbox', { name: /I accepted all terms/ }).check();
  await joinerPage.getByRole('button', { name: 'Activate my account' }).click();

  await expect(joinerPage).toHaveURL(/\/dashboard$/);
  await expect(joinerPage.getByRole('heading', { level: 1 })).toContainText('Nisha');

  // The link works once only.
  await joinerPage.goto(inviteUrl);
  await expect(joinerPage.getByText(/already been used/i)).toBeVisible();
  await joinerContext.close();

  // --- A CSV import ------------------------------------------------------------------------------
  await page.getByRole('tab', { name: 'Import from CSV' }).click();
  await page.getByLabel('Employee CSV file').setInputFiles(importFile());

  // Checked, nothing created yet: the new department and the problem row are shown.
  await expect(page.getByText('Operations (OPS)')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'personal_email' })).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 people' }).click();

  await expect(page.getByText('Finished', { exact: true })).toBeVisible({ timeout: 30_000 });
  const resultRows = page.getByRole('row');
  await expect(resultRows.filter({ hasText: 'Omar Lead' }).getByText('Invited')).toBeVisible();
  await expect(resultRows.filter({ hasText: 'Priya Ops' }).getByText('Invited')).toBeVisible();
  await expect(resultRows.filter({ hasText: 'Bad Row' }).getByText('Not imported')).toBeVisible();
  await expect(resultRows.filter({ hasText: 'Omar Lead' }).getByText(/^NSK\d{4}$/)).toBeVisible();
  // Every invitation was emailed, so there are no links for HR to share by hand.
  await expect(page.getByRole('button', { name: 'Copy link' })).toHaveCount(0);

  const resultsDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download results' }).click();
  expect((await resultsDownload).suggestedFilename()).toBe('new-joiners-results.csv');

  // The imported people are invitations like any other.
  await page.getByRole('tab', { name: 'Invitations' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'priya.ops@example.com' })).toContainText(
    'reports to Omar Lead',
  );

  expect(problems, problems.join('\n')).toEqual([]);
});
