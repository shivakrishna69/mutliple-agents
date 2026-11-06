/**
 * The slides of the signed-out screens' showcase panel (components/auth/AuthShell.jsx): three per
 * screen, each a title and a line. Marketing copy only: no claims of certifications or customers.
 * Every message a screen shows (errors, confirmations) comes from the API.
 */

const slides = (...entries) => Object.freeze(entries.map(([title, text]) => Object.freeze({ title, text })));

export const AUTH_SLIDES = Object.freeze({
  SIGN_IN: slides(
    [
      'Welcome back to clarity.',
      'Your people, leave, attendance and payroll in one calm workspace, with AI assistants ready when you are.',
    ],
    [
      'Every request, one place.',
      'Approve leave, review attendance and answer questions without switching between tools.',
    ],
    [
      'Built for the whole team.',
      'Employees, managers and HR each see exactly what they need, and nothing they should not.',
    ],
  ),
  SIGN_UP: slides(
    [
      'People operations, effortlessly in sync.',
      'Onboarding, leave, attendance and payroll work together from day one, so your team spends less time on paperwork.',
    ],
    ['Answers in seconds.', 'AI assistants explain balances, policies and payslips in plain words, any time of day.'],
    [
      'Your data stays yours.',
      'Every action is checked on the server and every sign-in is protected, so your records stay private.',
    ],
  ),
  FORGOT_PASSWORD: slides(
    ['Seamless Account Recovery', 'Secure and swift access restoration whenever you need it.'],
    [
      'One code, one minute.',
      'We email a 6-digit code to your registered address. Enter it and choose a new password.',
    ],
    ['Only you can reset it.', 'The code works once, expires quickly and is never shown anywhere but your inbox.'],
  ),
  RESET_PASSWORD: slides(
    [
      'Protecting your digital presence.',
      'Strong authentication safeguards your workspace and keeps your team’s records uniquely yours.',
    ],
    ['Every device, signed out.', 'Changing your password ends every other session, so only you are signed in.'],
    ['Strong by design.', 'A good password mixes letters, numbers and a symbol. The meter shows you as you type.'],
  ),
  VERIFY_EMAIL: slides(
    [
      'One step to go.',
      'Confirm your email and your workspace is ready, with leave, attendance and payroll in one place.',
    ],
    ['Why we ask.', 'Confirming your address keeps your account recoverable and your notifications reaching you.'],
    ['Code or link, your choice.', 'Type the 6-digit code here, or open the link in the same email. Either one works.'],
  ),
  INVITATION: slides(
    ['Welcome to your workspace.', 'Your organisation has set up your account. Choose a password to step into it.'],
    ['Everything in one place.', 'Leave, attendance, payslips and your team, from your first day.'],
    ['Help when you need it.', 'AI assistants answer everyday HR questions in plain words, any time.'],
  ),
});

/** How long a slide stays before the next one, unless the person is pointing at or focused on the panel. */
export const AUTH_SLIDE_INTERVAL_MS = 7000;
