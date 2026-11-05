/**
 * The signed-out screens against the real backend: sign up, confirm the email with the code or the
 * link, sign in, and reset a forgotten password. Every message checked is the backend's own
 * constant, so a wording change on the server cannot silently break what the screens show.
 */

import { expect, test } from '@playwright/test';

import { ACCOUNT_EMAIL_MESSAGES, AUTH_MESSAGES } from '../../backend/constants/messages.js';
import { ACCOUNTS, PASSWORD, RESET_ACCOUNT } from './environment.js';
import { emailedCode, emailedLink, inboxCount, mainNavigation, signIn } from './helpers.js';

const NEW_PASSWORD = 'Fresh#Pass2027';

async function signUpThroughForm(page, { firstName, lastName, email }) {
  await page.goto('/signup');
  await page.getByLabel('First name').fill(firstName);
  await page.getByLabel('Last name').fill(lastName);
  await page.getByLabel('Work email address').fill(email);
  await page.getByLabel('Phone number').fill('98765 43210');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('checkbox', { name: /I agree to/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/check-email\?email=/);
  await expect(page.getByRole('status')).toHaveText(ACCOUNT_EMAIL_MESSAGES.SIGNUP_CHECK_EMAIL);
}

async function typeCode(page, code) {
  const boxes = page.getByRole('group', { name: 'Confirmation code' }).getByRole('textbox');
  await expect(boxes).toHaveCount(code.length);
  await boxes.first().click();
  await page.keyboard.type(code);
}

test('a new customer signs up, confirms with the emailed code, sees their workspace and signs out', async ({
  page,
}) => {
  await signUpThroughForm(page, { firstName: 'Priya', lastName: 'Nair', email: 'priya.nair@example.com' });

  // A wrong code is refused with the server's message, and the boxes are cleared for another try.
  const code = await emailedCode('priya.nair@example.com');
  const wrongCode = code.replace(/\d$/, (digit) => String((Number(digit) + 1) % 10));
  await typeCode(page, wrongCode);
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page.getByRole('alert')).toContainText(ACCOUNT_EMAIL_MESSAGES.VERIFICATION_CODE_INVALID);

  await typeCode(page, code);
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Priya');
  await expect(mainNavigation(page).getByRole('link', { name: 'Support chat' })).toBeVisible();
  await expect(mainNavigation(page).getByRole('link', { name: 'Users & roles' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // The session is gone on the server too: protected pages send the browser back to sign-in.
  await page.goto('/payroll');
  await expect(page).toHaveURL(/\/login$/);
});

test('signing in before confirming leads to "check your email", and the emailed link confirms', async ({ page }) => {
  await signUpThroughForm(page, { firstName: 'Rahul', lastName: 'Verma', email: 'rahul.verma@example.com' });
  // The resend button waits out the server's cooldown.
  await expect(page.getByText(/^Resend in/)).toBeVisible();

  await page.goto('/login');
  await page.getByLabel('Work email address').fill('rahul.verma@example.com');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/check-email\?email=rahul\.verma%40example\.com$/);
  await expect(page.getByRole('status')).toHaveText(ACCOUNT_EMAIL_MESSAGES.EMAIL_NOT_VERIFIED);

  const confirmationLink = await emailedLink('rahul.verma@example.com', '/verify-email');
  await page.goto(confirmationLink);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rahul');

  // The link works once: opened again (signed out), it says so and offers the way forward.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.goto(confirmationLink);
  await expect(page.getByRole('alert')).toContainText(ACCOUNT_EMAIL_MESSAGES.VERIFICATION_LINK_INVALID);
});

test('a forgotten password is reset from the emailed link, which then stops working', async ({ page }) => {
  const { email } = RESET_ACCOUNT;
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  const emailsBefore = await inboxCount(email);
  await page.getByLabel('Work email address').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toHaveText(ACCOUNT_EMAIL_MESSAGES.PASSWORD_RESET_REQUESTED);
  await expect.poll(() => inboxCount(email)).toBeGreaterThan(emailsBefore);

  const resetLink = await emailedLink(email, '/reset-password');
  await page.goto(resetLink);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Choose a new password');
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('status')).toHaveText(ACCOUNT_EMAIL_MESSAGES.PASSWORD_RESET_DONE);

  await page.goto(resetLink);
  await expect(page.getByRole('alert')).toContainText(ACCOUNT_EMAIL_MESSAGES.RESET_LINK_INVALID);

  await signIn(page, email, NEW_PASSWORD);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rohan');
});

test('a wrong password shows an error and keeps the user on the sign-in page', async ({ page }) => {
  await page.goto('/login');
  // An unknown email gets the same message as a wrong password, and spends no real account's login budget.
  await page.getByLabel('Work email address').fill('nobody@example.com');
  await page.getByLabel('Password', { exact: true }).fill('Wrong#Pass2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('alert')).toContainText('Sign-in failed');
  await expect(page.getByRole('alert')).toContainText(AUTH_MESSAGES.INVALID_CREDENTIALS);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
});

test('signed-out visitors are sent to sign-in, then on to their page', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, ACCOUNTS.admin.email);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Avery');
});
