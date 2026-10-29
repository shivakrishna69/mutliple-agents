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
seeded admin, HR and customer accounts, one onboarded employee without an office, and a leave
scenario (an employee with an office, a manager and a Casual Leave balance). A stand-in AI service
(`e2e/standInAiService.js`) answers the leave assistant, reading real data through the backend's
internal API. Your `backend/.env` is never used.

```bash
cd backend && npm ci            # the tests start the backend, so it needs its dependencies
cd ../frontend && npm ci
npx playwright install chromium # once per machine
npm run test:e2e                # MongoDB must be reachable at TEST_MONGO_URL (default mongodb://127.0.0.1:27017)
```

| File | Covers |
|---|---|
| `e2e/auth.spec.js` | Sign-up, sign-out (and the session ending on the server), wrong password, redirect to sign-in |
| `e2e/roles.spec.js` | What admin, HR and customers see; admin-only addresses redirect customers |
| `e2e/onboarding.spec.js` | HR invites a joiner, who activates the account from the link; the link works once |
| `e2e/payroll.spec.js` | The tax planner's result for a hand-checked salary |
| `e2e/pages.spec.js` | Every page of every role loads with no uncaught errors or 5xx responses; public payslip check |
| `e2e/leaveAssistant.spec.js` | The leave assistant answers from the real balance, its draft opens the apply form filled in and the employee sends it, and an unavailable assistant gets a plain message |
| `e2e/leaveRequests.spec.js` | An employee's badge reads Employee; a document upload with no file storage gets a plain explanation; the employee sees the price of a day's leave (full and half day) and sends it; the manager approves it; the employee asks to cancel it once started; the manager declines with a note; the calendar shows the leave |
| `e2e/workplaceAndLeaveAdmin.spec.js` | HR adds an office with 2nd and 4th Saturdays off, a holiday and the employee's base office; adds a leave type, grants days, sees an over-limit encashment refused, the payroll export and the balance check |

On failure, `playwright-report/` and `test-results/` hold screenshots and traces
(`npx playwright show-trace <trace.zip>`); CI uploads them as an artifact.

## Structure

```
src/App.jsx           route table (workforce pages are lazy-loaded)
src/api/              one module per backend area; httpClient.js handles cookies, CSRF and errors
src/auth/             AuthContext: session state and CSRF token
src/components/       AppShell (role-aware sidebar), RouteGuards, ui.jsx design primitives, feature panels
                      (workplace/: offices, holidays, base offices; leave/: my leave, calendar, approvals and
                      leave administration, the tabs of pages/LeaveCenter.jsx)
src/hooks/            useApiResource (load/abort/error), useSocket, useAgentTelemetry
src/pages/            one file per screen
src/constants/        routes and roles, messages, socket event names, workplace and leave labels
src/utils/            dates in the browser's time zone, CSV downloads
public/brand/         the Unitora logo (mark, wordmark, full logo; light and dark, SVG and PNG) and favicon
src/validation/       client-side form checks (the backend validates again)
```

Route guards only steer navigation; the backend authorises every request.
