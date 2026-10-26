/**
 * Opens every page each role can reach and fails on uncaught errors or 5xx API responses, so a
 * page that renders but breaks in the background is still caught.
 */

import { expect, test } from '@playwright/test';

import { ACCOUNTS } from './environment.js';
import { mainNavigation, signIn, watchForPageProblems } from './helpers.js';

const PAGES_BY_ROLE = {
  admin: [
    '/dashboard',
    '/attendance',
    '/payroll',
    '/analytics',
    '/console',
    '/organisation',
    '/people/onboarding',
    '/admin/users',
    '/admin/telemetry',
    '/account',
  ],
  hr: ['/dashboard', '/attendance', '/payroll', '/analytics', '/people/onboarding', '/account'],
  customer: ['/dashboard', '/support', '/attendance', '/payroll', '/analytics', '/account'],
};

for (const [role, pagePaths] of Object.entries(PAGES_BY_ROLE)) {
  test(`every ${role} page loads without errors`, async ({ page }) => {
    const problems = watchForPageProblems(page);
    await signIn(page, ACCOUNTS[role].email);
    for (const pagePath of pagePaths) {
      await page.goto(pagePath);
      await expect(page, `${role} should stay on ${pagePath}`).toHaveURL(new RegExp(`${pagePath}$`));
      await expect(mainNavigation(page)).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}

test('the public payslip verification page works without signing in', async ({ page }) => {
  const problems = watchForPageProblems(page);
  await page.goto('/verify/payslip');
  await expect(page).toHaveURL(/\/verify\/payslip$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(problems, problems.join('\n')).toEqual([]);
});
