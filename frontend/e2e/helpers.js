import { expect } from '@playwright/test';

import { PASSWORD } from './environment.js';

/** Signs in through the login form and waits for the dashboard. */
export async function signIn(page, email, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

export function mainNavigation(page) {
  return page.getByRole('navigation', { name: 'Main' });
}

/**
 * Collects uncaught page errors and failed API responses (5xx) while a test runs, so a page that
 * renders but breaks in the background still fails the test.
 */
export function watchForPageProblems(page) {
  const problems = [];
  page.on('pageerror', (pageError) => problems.push(`page error: ${pageError.message}`));
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 500) {
      problems.push(`${response.status()} from ${response.request().method()} ${new URL(response.url()).pathname}`);
    }
  });
  return problems;
}
