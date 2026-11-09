/**
 * One signed-in visit per access role (accounts in environment.js), checking that:
 *   - the sidebar lists exactly the pages the role's capabilities allow, in order, and the user card
 *     shows the role's badge;
 *   - the dashboard shows the sections the server sends that role, and none it must not see;
 *   - every page the role may open loads, without uncaught errors or 5xx API responses (so a page
 *     that renders but breaks in the background is still caught);
 *   - every guarded page the role may not open sends it back to the dashboard (CapabilityRoute).
 * One sign-in per role, because sign-ins are limited per account and other specs use them too.
 */

import { expect, test } from '@playwright/test';

import { ACCOUNTS } from './environment.js';
import { mainNavigation, signIn, watchForPageProblems } from './helpers.js';

/** Pages behind a capability route guard (App.jsx); everything else is open to every signed-in user. */
const GUARDED_PAGES = Object.freeze([
  '/support',
  '/console',
  '/organisation',
  '/people/onboarding',
  '/workplace',
  '/leave/admin',
  '/admin/users',
  '/admin/telemetry',
  '/admin/company',
  '/admin/knowledge',
]);

const EVERYONE_PAGES = Object.freeze([
  '/dashboard',
  '/attendance',
  '/payroll',
  '/analytics',
  '/leave',
  '/leave/calendar',
  '/leave/approvals',
  '/account',
]);

/**
 * Per role: its badge label, the sidebar in order, the guarded pages it may open, and its dashboard
 * (`shows` and `hides` are section headings).
 */
const ROLE_ACCESS = {
  admin: {
    badge: 'Admin',
    navigation: [
      'Overview',
      'Support console',
      'Attendance',
      'Leave',
      'Payroll',
      'Analytics hub',
      'Organisation',
      'Onboarding',
      'Workplace',
      'Departments & Agents',
      'Company',
      'Users & roles',
      'Agent telemetry',
      'Account',
    ],
    guardedPages: GUARDED_PAGES.filter((pagePath) => pagePath !== '/support'),
    shows: ['Recent conversations', 'Intelligence pulse', 'Connected services', 'Upcoming holidays'],
    hides: [],
  },
  hr: {
    badge: 'HR',
    navigation: ['Overview', 'Attendance', 'Leave', 'Payroll', 'Analytics hub', 'Onboarding', 'Workplace', 'Account'],
    guardedPages: ['/people/onboarding', '/workplace', '/leave/admin'],
    shows: ['Headcount by department', 'Upcoming holidays'],
    hides: ['Recent conversations', 'Connected services'],
  },
  finance: {
    badge: 'Finance & Payroll',
    navigation: ['Overview', 'Attendance', 'Leave', 'Payroll', 'Analytics hub', 'Account'],
    guardedPages: [],
    shows: [],
    hides: ['Recent conversations', 'Connected services', 'Headcount by department'],
  },
  it_admin: {
    badge: 'IT Administrator',
    navigation: [
      'Overview',
      'Attendance',
      'Leave',
      'Payroll',
      'Analytics hub',
      'Company',
      'Users & roles',
      'Agent telemetry',
      'Account',
    ],
    guardedPages: ['/admin/users', '/admin/telemetry', '/admin/company'],
    shows: ['Connected services'],
    hides: ['Recent conversations', 'Headcount by department'],
  },
  agent: {
    badge: 'Support Agent',
    navigation: [
      'Overview',
      'Support console',
      'Attendance',
      'Leave',
      'Payroll',
      'Analytics hub',
      'Organisation',
      'Account',
    ],
    guardedPages: ['/console', '/organisation'],
    shows: [],
    hides: ['Connected services', 'Headcount by department'],
  },
  employee: {
    badge: 'Employee',
    navigation: ['Overview', 'Support chat', 'Attendance', 'Leave', 'Payroll', 'Analytics hub', 'Account'],
    guardedPages: ['/support'],
    shows: ['Need a hand? We reply in seconds.'],
    hides: ['Recent conversations', 'Headcount by department', 'Connected services'],
  },
};

test('every role has a test account and an access entry', () => {
  expect(Object.keys(ROLE_ACCESS).sort()).toEqual(Object.keys(ACCOUNTS).sort());
});

for (const [role, access] of Object.entries(ROLE_ACCESS)) {
  test(`${role}: the sidebar, the pages it may open, and the ones it may not`, async ({ page }) => {
    // Up to 17 pages in one test (admin), each waiting for its data.
    test.setTimeout(90_000);
    const problems = watchForPageProblems(page);
    await signIn(page, ACCOUNTS[role].email);

    await expect(mainNavigation(page).getByRole('link')).toHaveText(access.navigation);
    await expect(page.getByRole('complementary').first().locator(`[data-role="${role}"]`)).toHaveText(access.badge);

    for (const heading of access.shows) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
    for (const heading of access.hides) {
      await expect(page.getByRole('heading', { name: heading })).toHaveCount(0);
    }
    if (access.shows.includes('Connected services')) {
      // The services' real state: the test backend's database answers.
      const database = page.getByRole('listitem').filter({ hasText: 'Database' });
      await expect(database.getByText('Operational')).toBeVisible();
    }

    for (const pagePath of [...EVERYONE_PAGES, ...access.guardedPages]) {
      await page.goto(pagePath);
      await expect(page, `${role} should stay on ${pagePath}`).toHaveURL(new RegExp(`${pagePath}$`));
      await expect(mainNavigation(page)).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
    }
    for (const pagePath of GUARDED_PAGES.filter((guarded) => !access.guardedPages.includes(guarded))) {
      await page.goto(pagePath);
      await expect(page, `${role} should be sent back from ${pagePath}`).toHaveURL(/\/dashboard$/);
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
