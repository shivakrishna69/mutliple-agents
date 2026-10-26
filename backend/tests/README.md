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

MongoDB comes from `TEST_MONGO_URL` (default `mongodb://127.0.0.1:27017`, e.g. the
`multiagent-mongo` container). If it is not reachable, the integration suites are skipped with a
message locally, and fail when `CI=true`.

## Writing a new test

- Put pure logic tests in `unit/` and anything that needs HTTP or the database in `integration/`.
- Start one server per file in `before()` and stop it in `after()`. Files run in parallel.
- Keep each file under the signup rate limit (10 signups per hour per IP).
- Seed data the API cannot create yet (such as departments) directly through `testServer.database`.
