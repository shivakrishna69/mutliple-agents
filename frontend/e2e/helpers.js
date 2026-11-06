import { expect } from '@playwright/test';

import { MAIL_INBOX_URL, PASSWORD } from './environment.js';

/** Signs in through the login form and waits for the dashboard. */
export async function signIn(page, email, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Work Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** Emails sent to `address` by the test backend, oldest first. */
async function inboxOf(address) {
  const response = await fetch(`${MAIL_INBOX_URL}/messages?to=${encodeURIComponent(address)}`);
  return response.json();
}

/**
 * The newest match of `pickFrom(message)` among the emails to `address`, waiting for one to arrive.
 * `pickFrom` returns the candidates found in one message.
 */
async function newestFromInbox(address, pickFrom, description) {
  let found = null;
  await expect
    .poll(
      async () => {
        found = (await inboxOf(address)).flatMap(pickFrom).at(-1) ?? null;
        return found;
      },
      { message: `an email to ${address} with ${description}` },
    )
    .not.toBeNull();
  return found;
}

/** The number of emails sent to `address` so far. */
export async function inboxCount(address) {
  return (await inboxOf(address)).length;
}

/**
 * The newest link starting with `pathPrefix` (e.g. '/invite') emailed to `address`, read from the
 * test backend's inbox; waits for the email to arrive.
 */
export function emailedLink(address, pathPrefix) {
  return newestFromInbox(
    address,
    (message) =>
      (message.text.match(/https?:\/\/\S+/g) ?? []).filter((url) => new URL(url).pathname.startsWith(`${pathPrefix}/`)),
    `a ${pathPrefix} link`,
  );
}

/** The newest confirmation code emailed to `address` (it leads the subject: "123456 is your …"). */
export function emailedCode(address) {
  return newestFromInbox(
    address,
    (message) => {
      const match = message.subject.match(/^(\d+) /);
      return match ? [match[1]] : [];
    },
    'a confirmation code',
  );
}

export function mainNavigation(page) {
  return page.getByRole('navigation', { name: 'Main' });
}

/**
 * Collects uncaught page errors and failed API responses (5xx) while a test runs, so a page that
 * renders but breaks in the background still fails the test. `expectedFailures` lists failures a
 * test provokes on purpose, written as they are reported ("503 from POST /api/vault/documents").
 */
export function watchForPageProblems(page, { expectedFailures = [] } = {}) {
  const problems = [];
  page.on('pageerror', (pageError) => problems.push(`page error: ${pageError.message}`));
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 500) {
      const problem = `${response.status()} from ${response.request().method()} ${new URL(response.url()).pathname}`;
      if (!expectedFailures.includes(problem)) problems.push(problem);
    }
  });
  return problems;
}

/** Today as "YYYY-MM-DD" in the browser test's own time zone. */
export function localToday(now = new Date()) {
  const pad2 = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}
