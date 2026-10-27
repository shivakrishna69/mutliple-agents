# Backend tests

Uses Node's built-in test runner (`node:test`), so there are no extra dependencies.

```bash
npm test                    # everything
npm run test:unit           # pure logic, no database (about 1 second)
npm run test:integration    # real server + MongoDB (about 15 seconds)
```

## Unit tests (`tests/unit/`)

| File | Covers |
|---|---|
| `payrollCalculator.test.js` | FY 2026-27 tax for both regimes, rebate and surcharge marginal relief, HRA, s.123 cap, EPF ceiling split, ESI, professional tax, input validation. Expected figures are worked out by hand from the statutory rules. |
| `conversationAccess.test.js` | Who may see a support conversation |
| `validators.test.js` | Signup, login, password and invitation input rules, including NoSQL-injection attempts |
| `environment.test.js` | Startup configuration: required and weak secrets, production-only rules, CORS, Redis, payslip and SMTP settings |
| `workforceAccess.test.js` | The organisation-wide HR access rule and its use by the document vault |
| `emails.test.js` | HTML escaping, the shared email layout and the invitation email |
| `calendarDates.test.js` | Calendar-date helpers across month, year and leap-day boundaries; nth weekday of the month |
| `workingDays.test.js` | Weekly offs (every week and 2nd/4th Saturday), holidays, half days and the sandwich rule, counted by hand on October 2026 |

## Integration tests (`tests/integration/`)

`testServer.js` starts the real `server.js` as a child process:

- on a free port, against a new randomly named database that is dropped afterwards;
- in an empty temporary directory, with a minimal environment, so your `backend/.env` (SMTP, S3,
  Redis, real secrets) is never used;
- with a cookie-keeping client that sends the CSRF token on writes, like the browser does.

| File | Covers |
|---|---|
| `auth.test.js` | Signup ignores a requested role, password hashing, identical errors for unknown email and wrong password, CSRF enforcement, session revocation on logout, password change |
| `permissions.test.js` | Bootstrap admin, admin-only user management, no self-promotion, HR/admin-only analytics and onboarding |
| `invitations.test.js` | Only the token hash is stored, one open invitation per email, who may invite whom, acceptance creates the user and profile exactly once, revoked/expired/malformed links |
| `okrs.test.js` | Concurrent edits get `409 STALE_VERSION`, key-result owners can check in, company objectives are HR/admin only, no OKR access without an employee profile |
| `errors.test.js` | Request ids, JSON 404 for unknown routes, malformed JSON answered with 400 |
| `socket.test.js` | Socket.IO handshake (session, tampered cookie, foreign origin), conversation rooms, live delivery, admin-only telemetry, sockets ended on role change and logout |
| `workforceAccess.test.js` | Payslip listing and the regularization review queue: own data, HR access, accounts without a profile |
| `offices.test.js` | The weekly-off startup migration, office CRUD with version checks and model validation, 2nd/4th Saturday rules, offices in use cannot be removed, base-office assignment |
| `workCalendar.test.js` | HR-only holiday changes, holiday clashes and office scoping, employees limited to their own office, employees without an office told to ask HR |

MongoDB comes from `TEST_MONGO_URL` (default `mongodb://127.0.0.1:27017`, e.g. the
`multiagent-mongo` container). If it is not reachable, the integration suites are skipped with a
message locally, and fail when `CI=true`.

## Writing a new test

- Put pure logic tests in `unit/` and anything that needs HTTP or the database in `integration/`.
- Start one server per file in `before()` and stop it in `after()`. Files run in parallel.
- Keep each file under the signup rate limit (10 signups per hour per IP).
- Build common data with `fixtures.js` (offices, departments, onboarded employees) rather than a
  local helper. Seed data the API cannot create yet (such as departments) directly through
  `testServer.database`; use `startTestServer({ seedBeforeStart })` for data that must exist before
  the server starts (for example to test a startup migration).
