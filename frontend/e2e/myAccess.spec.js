/**
 * The My Access launcher in the browser:
 *   - signing in lands on /my-access, with no sidebar and one tile per page the role may open;
 *   - a tile opens its page, where the sidebar is back; the nine-dot button and "My Access" at the top
 *     of the sidebar both return to the launcher;
 *   - an administrator's tiles include the management tools;
 *   - the launcher, with its briefing bar, fits one screen at 1366×768 and 1920×1080.
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

  // Badges show the backend's own counts at this moment (other specs change them), and nothing at 0.
  const apiData = async (path) => (await (await page.request.get(path)).json()).data;
  const leavePending =
    (await apiData('/api/leave/approvals?queue=requests')).requests.length +
    (await apiData('/api/leave/approvals?queue=changes')).requests.length;
  const form16Pending = (await apiData('/api/tax/ca/employees')).summary.pending;
  for (const [label, count] of [
    ['Leave', leavePending],
    ['Form 16 / CA Portal', form16Pending],
  ]) {
    const badge = tileLabels(page).filter({ hasText: label }).getByTestId('my-access-badge');
    if (count > 0) await expect(badge).toHaveText(count > 99 ? '99+' : String(count));
    else await expect(badge).toHaveCount(0);
  }

  // The search filters as one types; × brings every tile back.
  const allTiles = await tileLabels(page).count();
  await page.getByLabel('Search modules').fill('payslip');
  await expect(tileLabels(page)).toHaveText(['Payroll & Form 16']);
  await page.getByLabel('Search modules').fill('no such module');
  await expect(page.getByTestId('my-access-no-match')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(tileLabels(page)).toHaveCount(allTiles);

  await tileLabels(page).filter({ hasText: 'Users & Roles' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Users & roles' })).toBeVisible();
  await expect(mainNavigation(page)).toBeVisible();
});

// My Access is one screen: the heading, the briefing bar and every tile fit without scrolling, for
// the role with the most tiles, on a common laptop and a full HD screen.
for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test(`My Access fits one screen at ${viewport.width}×${viewport.height}, with the briefing bar`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport, extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.23' } });
    const page = await context.newPage();
    await signIn(page, ACCOUNTS.admin.email, undefined, { stayOnLauncher: true });
    await expect(page.getByTestId('briefing-bar').getByTestId('briefing-headline')).toBeVisible();
    const lastTile = tileLabels(page).last();
    await expect(lastTile).toBeVisible();
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('main');
      return { main: main.scrollHeight - main.clientHeight, page: document.documentElement.scrollHeight - innerHeight };
    });
    expect(overflow.main, 'the launcher scrolls').toBeLessThanOrEqual(0);
    expect(overflow.page, 'the page scrolls').toBeLessThanOrEqual(0);
    await expect(lastTile).toBeInViewport({ ratio: 1 });
    await context.close();
  });
}
