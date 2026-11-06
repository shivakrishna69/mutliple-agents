# frontend

React 19 single-page app (Vite, Tailwind CSS v4, React Router, socket.io-client).

## Run

```bash
npm install
cp .env.example .env     # optional; defaults work for local development
npm run dev              # http://localhost:5173
```

In development, Vite proxies `/api` and `/socket.io` to the backend (`VITE_BACKEND_PROXY_TARGET`,
default `http://localhost:5000`), so the browser talks to one origin and session cookies just work.
For a deployed build, set `VITE_API_BASE_URL` or serve the build behind the same reverse proxy as the
API.

| Script | Purpose |
|---|---|
| `npm run dev` | development server with hot reload |
| `npm run build` | production build into `dist/` |
| `npm run preview` | serve the production build locally |
| `npm run lint` / `npm run format:check` | ESLint and Prettier checks |
| `npm run test:e2e` | browser tests (see below) |

## Browser tests

Playwright drives Chromium through the real app: the Vite dev server (port 5174) in front of the
real backend (port 5065), which `e2e/globalSetup.js` starts on a throwaway MongoDB database with
seeded admin, HR and customer accounts (plus one only the password-reset test uses), one onboarded employee without an office, and a leave
scenario (an employee with an office, a manager and a Casual Leave balance). A stand-in AI service
(`e2e/standInAiService.js`) answers the leave assistant, reading real data through the backend's
internal API. Emails go to a test inbox the tests read over HTTP (port 5066), as a person reads
their mail. Your `backend/.env` is never used.

```bash
cd backend && npm ci            # the tests start the backend, so it needs its dependencies
cd ../frontend && npm ci
npx playwright install chromium # once per machine
npm run test:e2e                # MongoDB must be reachable at TEST_MONGO_URL (default mongodb://127.0.0.1:27017)
```

| File | Covers |
|---|---|
| `e2e/auth.spec.js` | Sign-up with the phone country picker, date of birth and gender, confirmed with the emailed code (a wrong code refused first); the server's message under each refused field; sign-out and the session ending on the server; a sign-in before confirming leads to "verify your email" and the emailed link confirms, once; forgot password with the emailed code, which also expires the emailed link; wrong password; redirect to sign-in |
| `e2e/roles.spec.js` | What admin, HR and customers see; the admin changes the employee ID format and email domain; admin-only addresses redirect customers |
| `e2e/onboarding.spec.js` | HR invites a joiner (who gets an employee ID), who activates the account from the link (after agreeing to the terms); the link works once; HR imports a CSV with a new department, a manager, their report and a bad row, starts it, sees every row's outcome and downloads the results |
| `e2e/payroll.spec.js` | The tax planner's result for a hand-checked salary |
| `e2e/pages.spec.js` | Every page of every role loads with no uncaught errors or 5xx responses; public payslip check |
| `e2e/leaveApprovalSteps.spec.js` | Leave that needs two approvals: the employee sees both steps waiting, the manager approves the first, a decision on a step someone else has just decided is refused and the queue reloads, the HR step charges the leave and the employee sees it approved |
| `e2e/leaveAssistant.spec.js` | The leave assistant answers from the real balance, its draft opens the apply form filled in and the employee sends it, and an unavailable assistant gets a plain message |
| `e2e/leaveRequests.spec.js` | An employee's badge reads Employee; a document upload with no file storage gets a plain explanation; the employee sees the price of a day's leave (full and half day) and sends it; the manager approves it; the employee asks to cancel it once started; the manager declines with a note; the calendar shows the leave |
| `e2e/workplaceAndLeaveAdmin.spec.js` | HR adds a department, deactivates and reactivates it; adds an office with 2nd and 4th Saturdays off, a holiday and the employee's base office; adds a leave type, grants days, sees an over-limit encashment refused, the payroll export and the balance check |

On failure, `playwright-report/` and `test-results/` hold screenshots and traces
(`npx playwright show-trace <trace.zip>`); CI uploads them as an artifact.

## Structure

```
src/App.jsx           route table (workforce pages are lazy-loaded)
src/api/              one module per backend area; httpClient.js handles cookies, CSRF and errors
src/auth/             AuthContext: session state and CSRF token
src/components/       AppShell (role-aware sidebar), RouteGuards, ui.jsx design primitives, feature panels
                      (workplace/: departments, offices, holidays, base offices; people/: the CSV import;
                      leave/: my leave, calendar, approvals and leave administration, the tabs of
                      pages/LeaveCenter.jsx)
src/components/auth/  the signed-out screens (sign in, sign up, verify email, forgot and reset password,
                      invitation): AuthShell (one screen high, no page scroll; showcase panel with
                      code-drawn animated artwork and a slide caption), the sign-up fields (phone
                      with country picker, mm/dd/yyyy date, select), code entry with resend, the
                      compact strength bar built from the server's policy, notices. Inside the shell
                      the brand colour is blue (.auth-theme in index.css); signed-in pages keep orange
src/hooks/            useApiResource (load/abort/error), useAuthRequest (a submit with the server's field
                      errors), usePublicAuthSettings (branding, auth options with the signup choices, password policy; loaded
                      once), useCountdown, useSocket, useAgentTelemetry
src/pages/            one file per screen
src/constants/        routes and roles, messages, socket event names, workplace, leave and import labels,
                      the signed-out screens' slides (authScreens.js) and field styles (formStyles.js)
src/utils/            dates in the browser's time zone, CSV downloads, dates of birth (mm/dd/yyyy <-> YYYY-MM-DD)
public/brand/         the NSK logo (white letters for dark backgrounds, charcoal for light ones) and the square icons
src/validation/       client-side form checks (the backend validates again); the signed-out screens check
                      nothing themselves and show the server's messages
```

Route guards only steer navigation; the backend authorises every request.

## Fonts and flags

Served with the app, so no font or image request leaves the site:

- **Plus Jakarta Sans** (text) and **Michroma** (headings, `font-display`), both SIL Open Font
  License 1.1, from `@fontsource` packages imported in `src/index.css`.
- Country flags for the phone picker: `country-flag-icons` (MIT), one small SVG per country,
  loaded only when shown.
