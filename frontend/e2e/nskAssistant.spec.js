/**
 * The NSK assistant in the browser, answered by the stand-in AI service (e2e/standInAiService.js),
 * which calls the backend's real NSK tools with each turn's actor token:
 *
 *   employee   self-service: the type-ahead starters of their own intents only, the drawer from the
 *              top bar, a reply citing live portal data, a
 *              suggestion chip, the escalation banner for an urgent message, no offboarding cards or
 *              page; after a reload, the resume banner and its "Continue" chip, then deleting the
 *              conversation
 *   HR         the offboarding starter as they type; "<name> is leaving": the action cards and the
 *              one-tap "Yes, start offboarding" chip, the offboarding form, the settlement preview with
 *              the payment deadline banner, starting it, each document prepared (Socket.IO progress)
 *              and downloaded from S3
 *   finance    the settlement read-only, with only the statement downloadable
 *   IT         the notice checklist with the person leaving, and no pay figures
 *
 * The tests run in order: finance and IT read the case HR starts.
 */

import { expect, test } from '@playwright/test';

import { ACCOUNTS, EMPLOYEE, OFFBOARD_EMPLOYEE } from './environment.js';
import { mainNavigation, signIn, watchForPageProblems } from './helpers.js';
import { NSK_LEAVE_REPLY } from './standInAiService.js';

test.describe.configure({ mode: 'serial' });
// Its four sign-ins come from an address of their own (the backend trusts the dev server's proxy hop),
// so the other specs keep the shared per-IP sign-in budget (30 per 15 minutes).
test.use({ timezoneId: 'Asia/Kolkata', extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.54' } });

const ESCALATION_HINT = 'Need a person? Contact HR directly, and they will help you';
const PLACEHOLDER = 'Ask NSK anything about your work, leave or company policies…';

function drawerOf(page) {
  return page.getByRole('dialog', { name: 'NSK assistant' });
}

async function ask(drawer, text) {
  await drawer.getByLabel(PLACEHOLDER).fill(text);
  await drawer.getByRole('button', { name: 'Send' }).click();
}

// The company's calendar (Asia/Kolkata), which the backend counts notice days in, rather than the test
// runner's: on a UTC runner the two disagree between 18:30 and midnight UTC.
const COMPANY_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const inDays = (days) => COMPANY_DATE.format(new Date(Date.now() + days * 86_400_000));

test('an employee asks NSK, picks up the conversation later, and deletes it', async ({ page }) => {
  test.setTimeout(90_000);
  const problems = watchForPageProblems(page);
  await signIn(page, EMPLOYEE.email);
  await expect(mainNavigation(page).getByRole('link', { name: 'Offboarding' })).toHaveCount(0);

  await page.getByTestId('nsk-open-topbar').click();
  const drawer = drawerOf(page);
  await expect(drawer.getByText('How can I help?')).toBeVisible();

  // Type-ahead: starters for what an employee may ask, never offboarding.
  const box = drawer.getByLabel(PLACEHOLDER);
  const starters = drawer.getByTestId('nsk-prompt-helpers');
  await box.fill('debo');
  await expect(starters).toHaveCount(0);
  await box.fill('leav');
  await starters.getByRole('button', { name: 'Check my leave balances' }).click();
  await expect(box).toHaveValue('Check my leave balances');
  await expect(box).toBeFocused();
  await expect(starters).toHaveCount(0);
  await box.fill('');

  await ask(drawer, 'How much leave do I have?');
  await expect(drawer.getByText(NSK_LEAVE_REPLY.split(' [')[0])).toBeVisible();
  const liveData = drawer.locator('[data-source-kind="TOOL"]');
  await expect(liveData).toBeVisible();
  await expect(liveData).toContainText('Live portal data');
  await expect(drawer.getByRole('link', { name: 'Source 1' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /Start offboarding package/ })).toHaveCount(0);

  // A suggestion chip asks it.
  await drawer.getByRole('button', { name: 'Show my leave requests' }).click();
  await expect(drawer.locator('li[data-role="assistant"]')).toHaveCount(2);

  // An urgent message gets the escalation banner.
  await ask(drawer, 'This is urgent, my leave balance looks wrong');
  await expect(drawer.getByRole('alert').filter({ hasText: ESCALATION_HINT })).toBeVisible();

  // Later: the resume banner offers to continue.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.reload();
  await page.getByTestId('nsk-open-sidebar').click();
  const resume = drawer.getByTestId('nsk-resume');
  await expect(resume).toContainText('Pick up where you left off');
  await resume.getByRole('button', { name: /^Continue: / }).click();
  await expect(drawer.locator('li[data-role="assistant"]')).toHaveCount(3);

  // Deleting the conversation.
  const sessionMenu = drawer.locator('button[aria-haspopup="true"]');
  await sessionMenu.click();
  await drawer.getByRole('button', { name: /^Delete conversation: / }).click();
  // The menu stays open: the list is now empty, and the chat starts afresh.
  await expect(drawer.getByText('No conversations yet')).toBeVisible();
  await expect(drawer.getByText('How can I help?')).toBeVisible();
  expect(problems).toEqual([]);
});

test('HR offboards someone from NSK: preview, start, and download the documents', async ({ page }) => {
  test.setTimeout(150_000);
  const problems = watchForPageProblems(page);
  await signIn(page, ACCOUNTS.hr.email);
  await page.getByTestId('nsk-open-topbar').click();
  const drawer = drawerOf(page);

  // Type-ahead offers HR the offboarding starter, to finish with the name.
  const box = drawer.getByLabel(PLACEHOLDER);
  await box.fill('debo');
  await drawer.getByTestId('nsk-prompt-helpers').getByRole('button', { name: 'Start offboarding for [name]' }).click();
  await expect(box).toHaveValue('Start offboarding for ');

  await ask(drawer, `${OFFBOARD_EMPLOYEE.name} is leaving`);
  await expect(drawer.getByRole('button', { name: /View profile first/ })).toBeVisible();
  await expect(
    drawer.getByRole('button', { name: new RegExp(`Start offboarding package: ${OFFBOARD_EMPLOYEE.name}`) }),
  ).toBeVisible();
  // The one-tap confirmation chip opens the same form as the card.
  await drawer.getByRole('button', { name: `Yes, start offboarding for ${OFFBOARD_EMPLOYEE.name}` }).click();

  const panel = drawer.getByTestId('offboarding-panel');
  await panel.getByLabel('Last working day').fill(inDays(20));
  await panel.getByLabel('Exit reason (optional)').fill('Relocating');
  // No payslip or offer for this person: HR enters the salary, and the TDS so the year does not matter.
  await panel.getByText('Adjustments (leave empty to use what the portal holds)').click();
  await panel.getByLabel('Monthly gross (₹)').fill('60000');
  await panel.getByLabel('Monthly Basic + DA (₹)').fill('30000');
  await panel.getByLabel('TDS (₹), to replace the computed tax').fill('0');
  await panel.getByRole('button', { name: 'Preview settlement' }).click();

  const breakdown = panel.getByTestId('settlement-breakdown');
  await expect(breakdown).toContainText('Pay the full and final settlement by');
  await expect(breakdown).toContainText('Code on Wages, 2019');
  await expect(panel.getByTestId('settlement-net')).toBeVisible();

  await panel.getByRole('button', { name: 'Start offboarding' }).click();
  const documents = panel.getByTestId('offboarding-documents');
  await expect(documents).toHaveAttribute('data-status', 'COMPLETED', { timeout: 90_000 });
  for (const step of ['RELIEVING_LETTER', 'SETTLEMENT_STATEMENT', 'ATTENDANCE_AUDIT']) {
    await expect(documents.locator(`[data-step="${step}"]`)).toHaveAttribute('data-state', 'ready');
  }

  // The signed link opens in a new tab (noopener, so watched from the browser context): it fetches the
  // stored statement from S3.
  const fileRequest = page
    .context()
    .waitForEvent('request', (request) => request.url().includes('company-offboarding/'));
  await documents.getByRole('button', { name: 'Download Full and final settlement statement (PDF)' }).click();
  expect((await fileRequest).url()).toMatch(/company-offboarding\/[0-9a-f]{24}\/settlement_statement_/);
  expect(problems).toEqual([]);
});

test('finance reads the settlement, and may download only the statement', async ({ page }) => {
  await signIn(page, ACCOUNTS.finance.email);
  await mainNavigation(page).getByRole('link', { name: 'Offboarding' }).click();
  await page.getByRole('button', { name: OFFBOARD_EMPLOYEE.name }).click();
  await expect(page.getByText('Read-only: figures as HR previewed them')).toBeVisible();
  const documents = page.getByTestId('offboarding-documents');
  await expect(documents.getByRole('button', { name: /Download Full and final settlement statement/ })).toBeVisible();
  await expect(documents.getByRole('button', { name: /Download Relieving and experience letter/ })).toHaveCount(0);
  await expect(documents.getByRole('button', { name: /Download 3-month attendance/ })).toHaveCount(0);
});

test('IT sees who is serving notice and what to revoke, without pay figures', async ({ page }) => {
  await signIn(page, ACCOUNTS.it_admin.email);
  await mainNavigation(page).getByRole('link', { name: 'Offboarding' }).click();
  await expect(page.getByRole('tab', { name: 'Settlements' })).toHaveCount(0);
  const people = page.getByRole('list', { name: 'IT checklist' });
  await expect(people).toContainText(OFFBOARD_EMPLOYEE.name);
  await expect(people).toContainText('20 days left');
  await expect(page.getByText('To do on the last working day')).toBeVisible();
  await expect(page.getByText(/₹/)).toHaveCount(0);
});
