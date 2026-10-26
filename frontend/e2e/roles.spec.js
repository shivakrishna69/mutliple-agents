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
});

test('HR sees onboarding but not admin tools', async ({ page }) => {
  await signIn(page, ACCOUNTS.hr.email);
  await expect(mainNavigation(page).getByRole('link', { name: 'Onboarding' })).toBeVisible();
  await expect(mainNavigation(page).getByRole('link', { name: 'Users & roles' })).toHaveCount(0);
});

test('a customer who types an admin address is sent back to their dashboard', async ({ page }) => {
  await signIn(page, ACCOUNTS.customer.email);
  for (const adminOnlyPath of ['/admin/users', '/admin/telemetry', '/people/onboarding', '/console']) {
    await page.goto(adminOnlyPath);
    await expect(page, `${adminOnlyPath} should redirect`).toHaveURL(/\/dashboard$/);
  }
});
