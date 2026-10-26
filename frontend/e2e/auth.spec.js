import { expect, test } from '@playwright/test';

import { ACCOUNTS, PASSWORD } from './environment.js';
import { mainNavigation, signIn } from './helpers.js';

test('a new customer signs up, sees their workspace and signs out', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Priya Nair');
  await page.getByLabel('Email address').fill('priya.nair@example.com');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Priya');
  await expect(mainNavigation(page).getByRole('link', { name: 'Support chat' })).toBeVisible();
  await expect(mainNavigation(page).getByRole('link', { name: 'Users & roles' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // The session is gone on the server too: protected pages send the browser back to sign-in.
  await page.goto('/payroll');
  await expect(page).toHaveURL(/\/login$/);
});

test('a wrong password shows an error and keeps the user on the sign-in page', async ({ page }) => {
  await page.goto('/login');
  // An unknown email gets the same message as a wrong password, and spends no real account's login budget.
  await page.getByLabel('Email address').fill('nobody@example.com');
  await page.getByLabel('Password', { exact: true }).fill('Wrong#Pass2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('alert')).toContainText('Sign-in failed');
  await expect(page.getByRole('alert')).toContainText('The email or password you entered is incorrect.');
  await expect(page).toHaveURL(/\/login$/);
});

test('signed-out visitors are sent to sign-in, then on to their page', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, ACCOUNTS.customer.email);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Cyrus');
});
