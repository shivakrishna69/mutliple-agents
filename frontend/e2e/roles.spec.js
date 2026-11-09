/**
 * Users & roles and company settings, for the two roles that manage them. Which pages each role
 * sees and may open is checked in pages.spec.js.
 */

import { expect, test } from '@playwright/test';

import { ACCOUNTS } from './environment.js';
import { mainNavigation, signIn } from './helpers.js';

/** The group labels of a <select>'s <optgroup>s, in order. */
const groupLabelsOf = (select) =>
  select.locator('optgroup').evaluateAll((groups) => groups.map((group) => group.label));

test('an admin assigns any role from a grouped menu and changes the company settings', async ({ page }) => {
  await signIn(page, ACCOUNTS.admin.email);

  await mainNavigation(page).getByRole('link', { name: 'Users & roles' }).click();
  await expect(page.getByRole('heading', { name: 'Users & roles' })).toBeVisible();
  await expect(page.getByText(ACCOUNTS.employee.email)).toBeVisible();
  const hrRoleMenu = page.getByLabel(`Role for ${ACCOUNTS.hr.name}`);
  expect(await groupLabelsOf(hrRoleMenu)).toEqual(['Administration', 'Operations', 'Support', 'General']);
  await expect(hrRoleMenu.locator('optgroup[label="Operations"] option')).toHaveText([
    'HR',
    'Finance & Payroll',
    'IT Administrator',
  ]);
  await expect(hrRoleMenu).toHaveValue('hr');
  // Badges name each role in the table.
  const itRow = page.getByRole('row').filter({ hasText: ACCOUNTS.it_admin.email });
  await expect(itRow.getByLabel(`Role for ${ACCOUNTS.it_admin.name}`)).toHaveValue('it_admin');

  await mainNavigation(page).getByRole('link', { name: 'Company' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Company' })).toBeVisible();
  await page.getByLabel('Short code').fill('acme');
  await page.getByLabel('Digits').fill('5');
  await expect(page.getByText('ACME00001')).toBeVisible();
  await page.getByLabel('Company email domain').fill('Example.COM');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Company settings saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Company email domain')).toHaveValue('example.com');
  await expect(page.getByLabel('Short code')).toHaveValue('ACME');
});

test('an IT administrator manages accounts but never administration, and opens company settings', async ({ page }) => {
  await signIn(page, ACCOUNTS.it_admin.email);

  await mainNavigation(page).getByRole('link', { name: 'Users & roles' }).click();
  await expect(page.getByRole('heading', { name: 'Users & roles' })).toBeVisible();
  await expect(page.getByText('Only an admin can grant administration.')).toBeVisible();

  // An admin's row is read-only, with its badge.
  const adminRow = page.getByRole('row').filter({ hasText: ACCOUNTS.admin.email });
  await expect(adminRow.getByText('Only an admin can change an admin’s role')).toBeVisible();
  await expect(adminRow.getByRole('combobox')).toHaveCount(0);
  await expect(adminRow.getByText('Admin', { exact: true })).toBeVisible();

  // Other rows offer every role but Admin, grouped.
  const agentRoleMenu = page.getByLabel(`Role for ${ACCOUNTS.agent.name}`);
  expect(await groupLabelsOf(agentRoleMenu)).toEqual(['Operations', 'Support', 'General']);
  await expect(agentRoleMenu.locator('option', { hasText: /^Admin$/ })).toHaveCount(0);

  await mainNavigation(page).getByRole('link', { name: 'Company' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Company' })).toBeVisible();
  await expect(page.getByLabel('Company email domain')).toHaveValue('example.com');
});
