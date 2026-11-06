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
    '/workplace',
    '/leave',
    '/leave/calendar',
    '/leave/approvals',
    '/leave/admin',
    '/admin/users',
    '/admin/telemetry',
    '/admin/company',
    '/account',
  ],
  hr: [
    '/dashboard',
    '/attendance',
    '/payroll',
    '/analytics',
    '/people/onboarding',
    '/workplace',
    '/leave',
    '/leave/calendar',
    '/leave/approvals',
    '/leave/admin',
    '/account',
  ],
  customer: [
    '/dashboard',
    '/support',
    '/attendance',
    '/leave',
    '/leave/calendar',
    '/leave/approvals',
    '/payroll',
    '/analytics',
    '/account',
  ],
};

/**
 * What each role's dashboard shows (the server sends only the sections a role may see), and what
 * it must not show. Checked right after signing in, which lands on the dashboard.
 */
const DASHBOARD_BY_ROLE = {
  admin: {
    shows: ['Recent conversations', 'Intelligence pulse', 'Connected services', 'Upcoming holidays'],
    hides: [],
  },
  hr: {
    shows: ['Headcount by department', 'Upcoming holidays'],
    hides: ['Recent conversations', 'Connected services'],
  },
  customer: {
    shows: ['Need a hand? We reply in seconds.'],
    hides: ['Recent conversations', 'Headcount by department'],
  },
};

for (const [role, pagePaths] of Object.entries(PAGES_BY_ROLE)) {
  test(`every ${role} page loads without errors`, async ({ page }) => {
    // Up to 16 pages in one test (admin), each waiting for its data.
    test.setTimeout(60_000);
    const problems = watchForPageProblems(page);
    await signIn(page, ACCOUNTS[role].email);
    for (const heading of DASHBOARD_BY_ROLE[role].shows) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
    for (const heading of DASHBOARD_BY_ROLE[role].hides) {
      await expect(page.getByRole('heading', { name: heading })).toHaveCount(0);
    }
    if (role === 'admin') {
      // The services' real state: the test backend's database answers.
      const database = page.getByRole('listitem').filter({ hasText: 'Database' });
      await expect(database.getByText('Operational')).toBeVisible();
    }
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
