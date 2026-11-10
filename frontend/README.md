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
| `e2e/roles.spec.js` | Users & roles for an admin (every role, grouped) and an IT administrator (never Admin; admins' rows read-only); company settings for both |
| `e2e/onboarding.spec.js` | HR invites a joiner (who gets an employee ID), who activates the account from the link (after agreeing to the terms); the link works once; HR imports a CSV with a new department, a manager, their report and a bad row, starts it, sees every row's outcome and downloads the results |
| `e2e/payroll.spec.js` | The tax planner's result for a hand-checked salary |
| `e2e/pages.spec.js` | For each of the six roles: the exact sidebar, the role badge and dashboard sections, every page it may open loads with no uncaught errors or 5xx responses, and every guarded page it may not open redirects to the dashboard; public payslip check |
| `e2e/leaveApprovalSteps.spec.js` | Leave that needs two approvals: the employee sees both steps waiting, the manager approves the first, a decision on a step someone else has just decided is refused and the queue reloads, the HR step charges the leave and the employee sees it approved |
| `e2e/leaveAssistant.spec.js` | The leave assistant answers from the real balance, its draft opens the apply form filled in and the employee sends it, and an unavailable assistant gets a plain message |
| `e2e/leaveRequests.spec.js` | An employee's badge reads Employee; a document upload with no file storage gets a plain explanation; the employee sees the price of a day's leave (full and half day) and sends it; the manager approves it; the employee asks to cancel it once started; the manager declines with a note; the calendar shows the leave |
| `e2e/questionsInbox.spec.js` | Department agents in two browsers: the head adds a document; an employee asks the agent, sees the answer appear as it is written with its source card and citation link, rates it; a question the documents do not cover goes to the department; the head is notified live, opens it from the bell, answers and saves it as an FAQ; the employee is notified live and reads the reply in their conversation; the FAQ becomes a Ready document |
| `e2e/knowledgeHub.spec.js` | An admin opens Departments & Agents, an agent nobody has set up yet, and saves its instructions; switching to self-service leaves the management page and is remembered after a reload; the department head reaches the knowledge base from self-service, sees those instructions, uploads a document that becomes Ready while the list refreshes itself, sees a disguised file refused with the server's reason, and deletes the document; an employee who leads nothing sees no entry and cannot open the hub; HR switches views without the admin-only hub |
| `e2e/workplaceAndLeaveAdmin.spec.js` | HR adds a department, deactivates and reactivates it; adds an office with 2nd and 4th Saturdays off, a holiday and the employee's base office; adds a leave type, grants days, sees an over-limit encashment refused, the payroll export and the balance check |

On failure, `playwright-report/` and `test-results/` hold screenshots and traces
(`npx playwright show-trace <trace.zip>`); CI uploads them as an artifact.

## Structure

```
src/App.jsx           route table (workforce pages are lazy-loaded)
src/api/              one module per backend area; httpClient.js handles cookies, CSRF and errors, and
                      streams newline-delimited JSON answers (streamApiRequest)
src/auth/             AuthContext: session state and CSRF token
src/components/       AppShell (dark sidebar built from the signed-in person's capabilities, top bar with
                      breadcrumb, the portal switcher for admins, HR and IT administrators, the
                      notification bell (NotificationCenter, live over the socket) and, with
                      VIEW_SYSTEM_HEALTH, the services' state), PortalSwitcher, RouteGuards (CapabilityRoute),
                      ui.jsx design primitives, feature panels (knowledge/: a department agent's
                      settings with the lead picker and who may ask it, its documents with upload, status
                      and delete, and its Questions Inbox; agentChat/: a conversation's messages with
                      citation links, source cards and thumbs up/down;
                      workplace/: departments, offices, holidays, base offices; people/: the CSV import;
                      leave/: my leave, calendar, approvals and leave administration, the tabs of
                      pages/LeaveCenter.jsx)
src/components/auth/  the signed-out screens (sign in, sign up, verify email, forgot and reset password,
                      invitation): AuthShell (one screen high, no page scroll; showcase panel with
                      code-drawn animated artwork and a slide caption), the sign-up fields (phone
                      with country picker, mm/dd/yyyy date, select), code entry with resend, the
                      compact strength bar built from the server's policy, notices
src/components/dashboard/  the Overview page's parts, from GET /api/dashboard/overview (sections by role)
                      and /api/system/health: stat cards, recent conversations, intelligence pulse
                      with the activity chart (plain SVG), console, team & roles, connected services,
                      the people row, headcount, holidays, the employee's own day, the customer view
src/hooks/            useApiResource (load/abort/error), useAuthRequest (a submit with the server's field
                      errors), usePublicAuthSettings (branding, auth options with the signup choices, password policy; loaded
                      once), useSystemHealth (admins; one check shared by the top bar and the dashboard),
                      useCountdown, useSocket, useAgentTelemetry, usePortalView (the view an admin or HR
                      person chose, remembered in this browser), useNotifications (the bell's list,
                      kept current over the socket and reloaded after a reconnect)
src/pages/            one file per screen
src/constants/        routes and roles, messages, socket event names, workplace, leave and import labels,
                      the signed-out screens' slides (authScreens.js), field styles (formStyles.js) and
                      the dashboard's status labels and tones (dashboardDisplay.js), the portal views
                      (portal.js), the knowledge base statuses (knowledge.js) and department agent chat
                      (agentChat.js)
src/utils/            dates in the browser's time zone, CSV downloads, dates of birth (mm/dd/yyyy <-> YYYY-MM-DD),
                      the dashboard's numbers (shares, durations; "—" when there is nothing to measure)
public/brand/         the NSK logo (white letters for dark backgrounds, charcoal for light ones) and the square icons
src/validation/       client-side form checks (the backend validates again); the signed-out screens check
                      nothing themselves and show the server's messages
```

Navigation follows capabilities, not role names: the server sends the signed-in person's
capabilities with their profile (`user.capabilities`), `auth/capabilities.js` answers "may they do
X?", and each sidebar item and `CapabilityRoute` names the capability it needs
(`constants/capabilities.js`, kept equal to the backend's by a backend unit test). Route guards only
steer navigation; the backend authorises every request.

**Portal views.** Admins and HR switch, in the top bar (in the menu on small screens), between
"Employee self-service" (their own pages) and "Admin / Management" (the management tools too; where
they start). Each sidebar item names the views it belongs to (AppShell.jsx); switching away from a
page the new view does not include goes to the overview. The choice is a display preference kept in
this browser, not a permission. Everyone else has one sidebar, as before.

**Department knowledge bases.** Admins open every department's in Management → Departments & Agents
(`/admin/knowledge`); a department's head or knowledge lead opens theirs from self-service → My
department's knowledge base (`/knowledge`, shown only to them, from GET /api/knowledge-bases). Both
lead to the same page, with Settings and Documents tabs (`?tab=documents`).

## Theme

The brand colour is blue #1F5BFF everywhere (the `--color-brand-*` tokens in `src/index.css`); the NSK
logo keeps its own colours.

## Fonts and flags

Served with the app, so no font or image request leaves the site:

- **Plus Jakarta Sans** (text) and **Michroma** (headings, `font-display`), both SIL Open Font
  License 1.1, from `@fontsource` packages imported in `src/index.css`.
- Country flags for the phone picker: `country-flag-icons` (MIT), one small SVG per country,
  loaded only when shown.

## Department agents

`/agents` lists the department agents the person may ask (their own department's and every shared
service's); `/agents/:departmentId` is one agent's chat (pages/AgentChat.jsx). An answer streams in
as the agent writes it (api/agentChatApi.js streamAgentQuestion over httpClient.js streamApiRequest);
the stored answer replaces the streamed text when it is complete. Each citation mark ([1]) links to
its source card: the document, its section and page, and the quoted excerpt (never the whole
document). Thumbs down, or an answer the agent could not give, sends the question to the
department; the answer then says so, and shows when the department replies. A new conversation gets
its address (`?conversation=<id>`) as soon as the question is stored, which is where the backend's
notifications and emails link.

Heads and knowledge leads answer in the **Questions** tab of the knowledge base page
(components/knowledge/QuestionsInboxPanel.jsx, `?tab=questions&question=<id>`), optionally saving the
answer as an FAQ document. Both sides are told in the notification bell, live over the socket
(`NOTIFICATION_CREATED`); opening a notification goes to the page it names and reloads it, even when
it is already open.
