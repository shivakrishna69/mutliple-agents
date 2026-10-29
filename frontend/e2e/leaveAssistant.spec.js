/**
 * The leave assistant in the browser, answered by the stand-in AI service (e2e/standInAiService.js):
 * a starter question answered from the employee's real balance, a draft that opens the normal
 * apply form filled in and is sent by the employee, and a clear message when the assistant is
 * unavailable. The request is withdrawn at the end, so the leave test that books the same day
 * starts from the same balance.
 */

import { expect, test } from '@playwright/test';

import { LEAVE_EMPLOYEE, LEAVE_EMPLOYEE_CASUAL_DAYS } from './environment.js';
import { signIn, watchForPageProblems } from './helpers.js';
import { STAND_IN_TRIGGERS } from './standInAiService.js';

// The browser keeps the office's time zone, so "today" matches the employee's.
test.use({ timezoneId: 'Asia/Kolkata' });

test('the leave assistant answers, drafts a leave the employee sends, and says when it is unavailable', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // The last question makes the stand-in fail on purpose.
  const problems = watchForPageProblems(page, { expectedFailures: ['503 from POST /api/leave/assistant'] });
  await signIn(page, LEAVE_EMPLOYEE.email);
  await page.goto('/leave');
  const assistant = page.getByRole('heading', { name: 'Leave assistant' }).locator('xpath=ancestor::section');

  // A starter question, answered from the real balance.
  await assistant.getByRole('button', { name: 'How much leave do I have?' }).click();
  await expect(
    assistant.getByText(`You have ${LEAVE_EMPLOYEE_CASUAL_DAYS} days of Casual Leave available.`),
  ).toBeVisible();

  // A draft: shown as not sent, then opened in the normal form, where the employee sends it.
  await assistant
    .getByLabel('Ask the leave assistant')
    .fill(`Please ${STAND_IN_TRIGGERS.BOOK} today off for the dentist`);
  await assistant.getByRole('button', { name: 'Ask' }).click();
  await expect(assistant.getByText('Draft, not sent')).toBeVisible();
  await expect(assistant.getByText('“Dentist appointment”')).toBeVisible();
  await assistant.getByRole('button', { name: 'Review and send' }).click();

  await expect(page.getByRole('heading', { name: 'Review the assistant’s draft' })).toBeVisible();
  await expect(page.getByLabel('Leave type')).toHaveValue(/[0-9a-f]{24}/);
  await expect(page.getByLabel('Leave type').locator('option:checked')).toHaveText('Casual Leave (CL)');
  await expect(page.getByLabel('Reason')).toHaveValue('Dentist appointment');
  await expect(page.getByText('This leave costs 1 day')).toBeVisible();
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Your manager has been told and will decide it.')).toBeVisible();

  const requestRow = page.getByRole('listitem').filter({ hasText: 'Dentist appointment' });
  await expect(requestRow.getByText('Waiting for approval')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await requestRow.getByRole('button', { name: 'Withdraw' }).click();
  await expect(requestRow.getByText('Cancelled')).toBeVisible();

  // When the assistant cannot answer, the employee is told plainly and keeps their question.
  const unanswered = `Is the assistant ${STAND_IN_TRIGGERS.UNAVAILABLE} today?`;
  await assistant.getByLabel('Ask the leave assistant').fill(unanswered);
  await assistant.getByRole('button', { name: 'Ask' }).click();
  await expect(assistant.getByText('The leave assistant is not available right now')).toBeVisible();
  await expect(assistant.getByLabel('Ask the leave assistant')).toHaveValue(unanswered);

  expect(problems, problems.join('\n')).toEqual([]);
});
