import { expect, test } from '@playwright/test';

import { ACCOUNTS } from './environment.js';
import { mainNavigation, signIn } from './helpers.js';

test('an admin sees the admin tools and the list of users', async ({ page }) => {
  await signIn(page, ACCOUNTS.admin.email);
  await expect(mainNavigation(page).getByRole('link', { name: 'Agent telemetry' })).toBeVisible();

  await mainNavigation(page).getByRole('link', { name: 'Users & roles' }).click();
  await expect(page.getByRole('heading', { name: 'Users & roles' })).toBeVisible();
  await expect(page.getByText(ACCOUNTS.hr.email)).toBeVisible();
  await expect(page.getByText(ACCOUNTS.customer.email)).toBeVisible();

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

test('HR sees onboarding but not admin tools', async ({ page }) => {
  await signIn(page, ACCOUNTS.hr.email);
  await expect(mainNavigation(page).getByRole('link', { name: 'Onboarding' })).toBeVisible();
  await expect(mainNavigation(page).getByRole('link', { name: 'Users & roles' })).toHaveCount(0);
  await expect(mainNavigation(page).getByRole('link', { name: 'Company' })).toHaveCount(0);
});

test('a customer who types an admin address is sent back to their dashboard', async ({ page }) => {
  await signIn(page, ACCOUNTS.customer.email);
  for (const adminOnlyPath of [
    '/admin/users',
    '/admin/telemetry',
    '/admin/company',
    '/people/onboarding',
    '/console',
  ]) {
    await page.goto(adminOnlyPath);
    await expect(page, `${adminOnlyPath} should redirect`).toHaveURL(/\/dashboard$/);
  }
});
