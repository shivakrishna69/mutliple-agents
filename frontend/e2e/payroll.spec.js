import { expect, test } from '@playwright/test';

import { ACCOUNTS } from './environment.js';
import { signIn } from './helpers.js';

test('the tax planner shows zero new-regime tax at ₹12,75,000 gross and recommends it', async ({ page }) => {
  await signIn(page, ACCOUNTS.customer.email);
  await page.goto('/payroll');

  // 12,75,000 − 75,000 standard deduction = 12,00,000 taxable: fully covered by the s.156 rebate.
  await page.getByLabel('Gross salary').fill('1275000');
  await page.getByRole('button', { name: 'Compare regimes' }).click();

  // The regime card: the heading sits in the card's header row, so the card is two levels up.
  const newRegimeColumn = page.getByRole('heading', { name: 'new regime' }).locator('xpath=../..');
  await expect(newRegimeColumn.getByText('Recommended')).toBeVisible();
  // The card's first paragraph is the headline annual tax; the rows below it break the figure down.
  await expect(newRegimeColumn.locator('p').first()).toHaveText('₹0');
  await expect(newRegimeColumn.getByText(/^annual tax ·/)).toBeVisible();
});
