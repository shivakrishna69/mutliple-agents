import { expect, test } from '@playwright/test';

import { ACCOUNTS, DEPARTMENT_NAME, EMPLOYEE, KNOWLEDGE_ADMIN, KNOWLEDGE_HEAD } from './environment.js';
import { mainNavigation, signIn } from './helpers.js';

const INSTRUCTIONS = 'Answer from the engineering handbook. Say when you do not know.';

const portalButton = (page, name) => page.getByRole('group', { name: 'Portal view' }).getByRole('button', { name });

test('an admin manages a department agent from Departments & Agents, and switches between the two views', async ({
  page,
}) => {
  await signIn(page, KNOWLEDGE_ADMIN.email);
  await expect(portalButton(page, 'Admin / Management')).toHaveAttribute('aria-pressed', 'true');

  await mainNavigation(page).getByRole('link', { name: 'Departments & Agents' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Departments & Agents' })).toBeVisible();
  const engineeringRow = page.getByRole('row').filter({ hasText: DEPARTMENT_NAME });
  await expect(engineeringRow).toBeVisible();
  await expect(engineeringRow.getByText(KNOWLEDGE_HEAD.name)).toHaveCount(0);

  await engineeringRow.getByRole('link', { name: `Open ${DEPARTMENT_NAME}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: `${DEPARTMENT_NAME} Department Agent` })).toBeVisible();
  await expect(page.getByLabel('Knowledge lead')).toHaveValue(/.+/);
  await expect(page.getByLabel('Knowledge lead').locator('option:checked')).toContainText(KNOWLEDGE_HEAD.name);
  await page.getByLabel('Instructions').fill(INSTRUCTIONS);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Knowledge base settings saved')).toBeVisible();

  // The self-service view leaves out the management tools; this page is one of them.
  await portalButton(page, 'Employee self-service').click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(mainNavigation(page).getByRole('link', { name: 'Departments & Agents' })).toHaveCount(0);
  await expect(mainNavigation(page).getByRole('link', { name: 'Users & roles' })).toHaveCount(0);
  await expect(mainNavigation(page).getByRole('link', { name: 'Leave' })).toBeVisible();

  // Remembered in this browser.
  await page.reload();
  await expect(portalButton(page, 'Employee self-service')).toHaveAttribute('aria-pressed', 'true');
  await portalButton(page, 'Admin / Management').click();
  await expect(mainNavigation(page).getByRole('link', { name: 'Users & roles' })).toBeVisible();
});

test('a department head manages the knowledge base from self-service: settings, upload, failure, delete', async ({
  page,
}) => {
  await signIn(page, KNOWLEDGE_HEAD.email);
  await expect(page.getByRole('group', { name: 'Portal view' })).toHaveCount(0);

  await mainNavigation(page).getByRole('link', { name: "My department's knowledge base" }).click();
  // One department: it opens straight away.
  await expect(page).toHaveURL(/\/knowledge\/[0-9a-f]{24}$/);
  await expect(page.getByLabel('Instructions')).toHaveValue(INSTRUCTIONS);

  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(page).toHaveURL(/\?tab=documents$/);
  const documentInput = page.getByLabel('Documents to upload');
  await documentInput.setInputFiles({
    name: 'Handbook.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Handbook\n\nEveryone gets 24 days of leave a year.\n'),
  });
  await expect(
    page.getByText('Document uploaded. It is being read and will be ready for the agent shortly'),
  ).toBeVisible();
  const handbookRow = page.getByRole('row').filter({ hasText: 'Handbook.md' });
  // The list refreshes itself until the document is read and indexed.
  await expect(handbookRow.getByText('Ready')).toBeVisible({ timeout: 20_000 });

  await documentInput.setInputFiles({
    name: 'policy.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('%PDF-1.4\n% a PDF named as text\n'),
  });
  await expect(page.getByText("The file's name does not match its content", { exact: false })).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await handbookRow.getByRole('button', { name: 'Delete Handbook.md' }).click();
  await expect(page.getByText('Document removed from the knowledge base')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Handbook.md' })).toHaveCount(0);
});

test('an employee who leads nothing never sees the knowledge base, and cannot open the admin hub', async ({ page }) => {
  await signIn(page, EMPLOYEE.email);
  await expect(mainNavigation(page).getByRole('link', { name: "My department's knowledge base" })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Portal view' })).toHaveCount(0);
  await page.goto('/admin/knowledge');
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/knowledge');
  await expect(page.getByText('No knowledge base to manage')).toBeVisible();
});

test('HR switches views too, without the administrators-only Departments & Agents', async ({ page }) => {
  await signIn(page, ACCOUNTS.hr.email);
  await expect(portalButton(page, 'Admin / Management')).toHaveAttribute('aria-pressed', 'true');
  await expect(mainNavigation(page).getByRole('link', { name: 'Onboarding' })).toBeVisible();
  await expect(mainNavigation(page).getByRole('link', { name: 'Departments & Agents' })).toHaveCount(0);
  await portalButton(page, 'Employee self-service').click();
  await expect(mainNavigation(page).getByRole('link', { name: 'Onboarding' })).toHaveCount(0);
  await expect(mainNavigation(page).getByRole('link', { name: 'Attendance' })).toBeVisible();
});
