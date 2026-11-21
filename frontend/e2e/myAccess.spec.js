/**
 * The My Access launcher in the browser:
 *   - signing in lands on /my-access, with no sidebar and one tile per page the role may open;
 *   - a tile opens its page, where the sidebar is back; the nine-dot button and "My Access" at the top
 *     of the sidebar both return to the launcher;
 *   - an administrator's tiles include the management tools.
 */

import { expect, test } from '@playwright/test';

import { ACCOUNTS } from './environment.js';
import { mainNavigation, signIn, watchForPageProblems } from './helpers.js';

// Its own client address, so these sign-ins stay out of the shared per-address budget.
test.use({ extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.23' } });

const tileLabels = (page) => page.getByTestId('my-access-tile');

test('an employee starts at My Access, opens a module, and comes back', async ({ page }) => {
  const problems = watchForPageProblems(page);
  await signIn(page, ACCOUNTS.employee.email, undefined, { stayOnLauncher: true });

  await expect(page.getByRole('heading', { level: 1, name: 'My Access' })).toBeVisible();
  await expect(mainNavigation(page)).toHaveCount(0);
  await expect(tileLabels(page)).toHaveText([
    'Ask NSK',
    'Overview',
    'Support Chat',
    'Ask an Agent',
    'Attendance',
    'Leave',
    'Payroll & Form 16',
    'Analytics Hub',
  ]);

  await tileLabels(page).filter({ hasText: 'Attendance' }).click();
  await expect(page).toHaveURL(/\/attendance$/);
  await expect(mainNavigation(page)).toBeVisible();
  await expect(mainNavigation(page).getByRole('link', { name: 'Attendance' })).toHaveAttribute('aria-current', 'page');

  await page.getByTestId('app-launcher').click();
  await expect(page).toHaveURL(/\/my-access$/);
  await expect(mainNavigation(page)).toHaveCount(0);

  await tileLabels(page).filter({ hasText: 'Payroll & Form 16' }).click();
  await expect(page).toHaveURL(/\/payroll$/);
  await mainNavigation(page).getByRole('link', { name: 'My Access' }).click();
  await expect(page).toHaveURL(/\/my-access$/);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('an administrator’s launcher has the management tools', async ({ page }) => {
  await signIn(page, ACCOUNTS.admin.email, undefined, { stayOnLauncher: true });
  for (const label of ['Onboarding', 'Workplace', 'Users & Roles', 'Company Settings', 'Form 16 / CA Portal']) {
    await expect(tileLabels(page).filter({ hasText: label })).toHaveCount(1);
  }
  await expect(tileLabels(page).filter({ hasText: 'Support Chat' })).toHaveCount(0);
  await tileLabels(page).filter({ hasText: 'Users & Roles' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Users & roles' })).toBeVisible();
  await expect(mainNavigation(page)).toBeVisible();
});
