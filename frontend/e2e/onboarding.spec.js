import { expect, test } from '@playwright/test';

import { ACCOUNTS, DEPARTMENT_NAME, PASSWORD } from './environment.js';
import { signIn } from './helpers.js';

test('HR invites a new joiner, who activates their account from the link', async ({ page, browser }) => {
  await signIn(page, ACCOUNTS.hr.email);
  await page.goto('/people/onboarding');
  await page.getByRole('button', { name: 'Invite someone' }).click();

  await page.getByLabel('Full name').fill('Nisha Kapoor');
  await page.getByLabel('Work email').fill('nisha.kapoor@example.com');
  await page.getByLabel('Job title').fill('Support Engineer');
  await page.getByLabel('Department').selectOption({ label: DEPARTMENT_NAME });
  await page.getByRole('button', { name: 'Send invitation' }).click();

  // No mail server in tests, so HR is given the link to share.
  const inviteLink = page.locator('code').filter({ hasText: '/invite/' });
  await expect(inviteLink).toBeVisible();
  const inviteUrl = (await inviteLink.textContent()).trim();
  await expect(page.getByText('nisha.kapoor@example.com')).toBeVisible();

  // The new joiner opens the link in their own browser (no shared cookies with HR).
  const joinerContext = await browser.newContext();
  const joinerPage = await joinerContext.newPage();
  await joinerPage.goto(inviteUrl);
  await expect(joinerPage.getByRole('heading', { level: 1 })).toContainText('Nisha');
  await expect(joinerPage.getByText('nisha.kapoor@example.com')).toBeVisible();
  await expect(joinerPage.getByText(`Support Engineer, ${DEPARTMENT_NAME}`)).toBeVisible();
  await joinerPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await joinerPage.getByLabel('Confirm password').fill(PASSWORD);
  await joinerPage.getByRole('button', { name: 'Activate my account' }).click();

  await expect(joinerPage).toHaveURL(/\/dashboard$/);
  await expect(joinerPage.getByRole('heading', { level: 1 })).toContainText('Nisha');

  // The link works once only.
  await joinerPage.goto(inviteUrl);
  await expect(joinerPage.getByText(/already been used/i)).toBeVisible();
  await joinerContext.close();
});
