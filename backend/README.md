# backend

Node.js / Express 5 API: authentication, roles, every business rule, MongoDB persistence and
real-time events (Socket.IO). Serves the frontend at `/api/*` and the AI service at `/api/internal/*`.

## Run

```bash
npm install
cp .env.example .env     # fill in the secrets; every value is documented in the template
npm run dev              # http://localhost:5000, restarts on file changes
```

Requires MongoDB (`MONGO_URI`). Startup validates the configuration and refuses to start with
missing or weak secrets (e.g. `JWT_SECRET`, `AI_SERVICE_API_KEY` shorter than 32 characters).

| Script | Purpose |
|---|---|
| `npm run dev` | development server with auto-restart |
| `npm start` | production start |
| `npm run set-role -- <email> <admin\|agent\|hr\|customer>` | recovery tool to change a role directly in the database |
| `npm run send-test-message` | sends a signed test message to the inbound webhook |
| `npm test` | unit and integration tests (integration needs MongoDB; see [tests/README.md](tests/README.md)) |
| `npm run lint` / `npm run format:check` | ESLint and Prettier checks |

## Structure

```
server.js        configuration loading/validation, middleware, route mounting, startup/shutdown
routes/          one Express router per area
controllers/     HTTP handlers: validate → authorise → call service → audit → respond
services/        business logic (payslips, OKRs, invitations, attendance, analytics…)
models/          Mongoose schemas with integrity rules (unique indexes, optimistic concurrency)
validators/      pure input validators
middleware/      auth (session + CSRF), roles, rate limits, uploads, webhook/internal-key checks
utils/           responses, audit log, logger, Socket.IO manager, payroll calculator, S3 client
constants/       messages, limits, rate-limit budgets, HTTP statuses
migrations/      idempotent data migrations, run in order at every startup
data/            data shipped with the server (the leave-type template seeded on first start)
scripts/         operational scripts
```

## API areas

| Mount | Purpose | Access |
|---|---|---|
| `/api/auth` | signup with email confirmation, login, logout, current user, password change, forgotten password reset | public / signed in |
| `/api/support`, `/api/conversations`, `/api/webhooks` | support desk | customers / staff / signed webhooks |
| `/api/admin` | users and roles | admin |
| `/api/attendance` | punch-in (office, home or on duty), punch-out, today's board, AI regularization, manager reviews | employees / managers / HR |
| `/api/presence` | my presence setup and notice, who is available/away/offline now, daily active hours | everyone (own) / managers / HR |
| `/api/payroll` | tax estimates, payslips, public payslip verification | employees / HR |
| `/api/analytics` | workforce attrition and burnout | HR, admin |
| `/api/okrs` | objectives, key results, milestones | employees with a profile |
| `/api/vault` | employee documents | owner / HR / admin |
| `/api/org` | org chart and reporting lines | staff |
| `/api/company` | company name, short code, mail domain, logo, colours, time zone, employee ID digits | public branding / HR read / admin change |
| `/api/departments` | departments with head counts: add, change, deactivate, remove unused | HR, admin |
| `/api/people`, `/api/invitations` | onboarding by email invitation | HR, admin / public token |
| `/api/offices` | offices: location, time zone, shift, weekly offs | HR, admin |
| `/api/employees` | current employees for pickers (invited people included); base office assignment; bulk CSV import | HR, admin |
| `/api/work-calendar` | holidays and the day-by-day calendar | HR, admin edit / employees read their office |
| `/api/leave` | leave settings and types, balances, ledger, adjustments, encashments, leave job; leave requests, approvals, payroll export | HR, admin manage / employees their own / reporting managers decide their team's requests |
| `/api/internal` | calls from the AI service | internal API key |

## Signup, email confirmation and password reset

Signing up creates an **unverified** account and emails a 6-digit code and a confirmation link; the
account cannot sign in until one of them is used (`services/accountEmailFlows.js`,
`controllers/accountEmailController.js`).

| Endpoint | What it does |
|---|---|
| `POST /api/auth/signup` `{ firstName, lastName, email, phoneCountry, phoneNumber, dateOfBirth, gender, password, confirmPassword, acceptTerms }` | 202 "check your email" with `resendAfterSeconds` and `codeDigits`; no session yet. The phone is checked for the picked country (`phoneCountry`, e.g. `IN`; India when left out) with libphonenumber-js and stored in E.164 (not verified yet). `dateOfBirth` is `YYYY-MM-DD`, at least 18 years ago; `gender` is one of the published choices. Both are checked and stored when sent, and become required with `SIGNUP_PROFILE_SETTINGS.BIRTH_DATE_AND_GENDER_REQUIRED`. The terms version and time agreed to are stored too |
| `POST /api/auth/verify-email` `{ token }` or `{ email, code }` | confirms the email and signs in (200, with the session) |
| `POST /api/auth/verify-email/resend` `{ email }` | a new code and link |
| `POST /api/auth/login` `{ email, password, rememberDevice }` | signs in; with `rememberDevice` the cookies last `REMEMBERED_SESSION_DAYS` (default 30), otherwise they end with the browser |
| `POST /api/auth/password/forgot` `{ email }` | a reset email with a 6-digit code and a link, for an active account (a confirmation email for an unverified one); answers with `linkValidMinutes` |
| `GET /api/auth/password/reset/:token` | whether a reset link still works, and until when |
| `POST /api/auth/password/reset` `{ token, password, confirmPassword }` or `{ email, code, password, confirmPassword }` | new password, with the emailed link or code; every session ends; the owner is emailed |
| `GET /api/auth/password-policy` | the password rules (each check's label and pattern) and the strength meter's levels, so screens show the server's own rules |
| `GET /api/auth/options` | `rememberedSessionDays`, `verificationCodeDigits` (confirmation and reset codes), `passwordResetLinkMinutes`; for signup `birthDateAndGenderRequired`, `minimumSignupAgeYears`, `genders` (`{ value, label }` in order), `defaultPhoneCountry` and `phoneCountries` (`{ code, name, callingCode }` by name) |

The signed-out screens also read `GET /api/company/branding`, which includes the company's
`supportEmail`, `termsUrl`, `privacyUrl` and `websiteUrl` ("Back to Home"), all set by the admin. The invitation preview
(`GET /api/invitations/:token`) names the inviter and the employee ID, and accepting it takes
`{ password, confirmPassword, acceptTerms }`. Every password form's repeat is checked on the server
(`PASSWORDS_DO_NOT_MATCH`).

- **Messages come from the server.** Every answer carries a `message` from `constants/messages.js`,
  and errors a stable `code`: `EMAIL_NOT_VERIFIED` (403 at login, right password only),
  `VERIFICATION_LINK_INVALID` / `VERIFICATION_CODE_INVALID` / `RESET_LINK_INVALID` / `RESET_CODE_INVALID` (400), `EMAIL_COOLDOWN` (429, with
  `Retry-After` and `error.context.retryAfterSeconds`), `EMAIL_UNAVAILABLE` (503, no SMTP).
  Screens show these texts; they do not write their own.
- **Links** are 32 random bytes; only their SHA-256 is stored (`models/AccountToken.js`). A link works
  once, expires (confirmation 24 h, reset 15 minutes: `ACCOUNT_EMAIL_SETTINGS`), and issuing one revokes
  the account's earlier ones, so only the newest works.
- **Codes** are stored as an HMAC keyed from `JWT_SECRET`, never in plain text. A code and the link
  of the same email are **one record**: using either one uses up the other at once, they expire
  together, the fifth wrong code cancels both, and asking for a new email replaces both. This holds
  for confirmation and for password reset alike.
- **Nothing reveals which emails are registered.** Signup, resend and forgot answer alike for every
  address; signing up with a registered one emails its owner instead.
- **Unconfirmed accounts can be taken over** by a new signup (its earlier links are revoked first)
  or by HR's invitation, so whoever types an address first cannot lock its owner out. The configured
  first administrator (`BOOTSTRAP_ADMIN_EMAIL`) confirms like everyone else. Accepting an invitation
  confirms the address.
- **Rate limits:** one account email per address per minute of each kind (`models/EmailCooldown.js`,
  stored in MongoDB, claimed for every address alike), plus per-IP budgets keyed on `req.ip`
  (X-Forwarded-For is trusted for exactly `TRUST_PROXY_HOPS` proxies).
- Accounts that existed before confirmation was required count as confirmed (startup migration).

## Onboarding: invitations and bulk import

Inviting someone (one at a time, or by CSV) creates their account and profile at once
(`services/employeeProvisioning.js`): the account is `invited` (no password, cannot sign in) and the
profile gets an employee ID from the company's short code (`NSK0001`, never reused). The emailed
link lets the person choose a password, which makes the account `active`. Each account keeps a
personal email (where invitations go, and the sign-in email for now) and, when the company has a
mail domain, a reserved company address (`firstname.lastname@domain`, numbered when taken).
Revoking an invitation disables the account; inviting the person again reuses it and their ID.

Bulk import (`/api/employees/bulk-upload`):

1. Upload a CSV (template: [docs/employee-import-template.csv](../docs/employee-import-template.csv);
   at most 2 MB and 5,000 rows). Every row is checked and nothing is created: emails, duplicates,
   roles the uploader may give, joining dates (YYYY-MM-DD), departments (unknown codes are created
   by the import), managers (a current employee, or a row in the same file), offices.
2. Start it (`POST /:jobId/confirm`). It runs in the background, managers before their teams, through
   the same path as a single invitation. With `REDIS_URL` it runs on a BullMQ queue (any instance's
   worker); without, in the backend process. Its state is in MongoDB either way, so a restart
   resumes it without creating anyone twice. Emails are paced by `IMPORT_EMAILS_PER_MINUTE`.
3. Poll `GET /:jobId` for progress; `GET /:jobId/results` gives every row's outcome, with the
   activation links that could not be emailed (stored encrypted until then, `utils/secretBox.js`).

Columns (case, spaces and hyphens do not matter): `name`, `personal_email`, `department_code`,
`designation`, `date_of_joining` are required; `company_email`, `department_name` (for a new
department), `role` (employee, hr, agent), `manager_email`, `work_type` (Onsite, Hybrid, Remote),
`employment_status` (Probation, Active) and `office_code` are optional.

## Leave balances

Every leave policy is data HR edits (`models/LeaveType.js`, `models/LeaveSettings.js`); a company
with no leave types gets the India standard template (`data/leave-templates/`) on first start.

- The ledger (`models/LeaveLedgerEntry.js`) is the source of truth and is never edited; balances
  (`models/LeaveBalance.js`) are its running totals. Amounts are whole hundredths of a day.
- Unique indexes make every accrual, year-end movement and payroll reference post at most once, so
  the leave job is safe to rerun and to run on several instances.
- Debits are reserved with one conditional update, so concurrent requests can never overdraw;
  `POST /api/leave/jobs/reconcile` repairs a balance if the server stopped half way through a write.
- The leave job (`services/leaveAccrualJob.js`) runs at startup and hourly: monthly or yearly
  accruals in each employee's office time zone, then each leave year's carry forward, lapse and
  encashment once the next year has started. HR can run it on demand.

## Leave requests

Employees price a leave before asking (`POST /api/leave/requests/preview`), then submit it. The
request goes to their reporting manager, or to HR's queue when they have none; HR and admins can
decide any request except their own.

- Each leave type's policy is checked on submission: who may use it, notice, how far back a request
  may start, minimum service, half days, the most days in one go, and when a supporting document
  (a Leave_Document the employee uploads to their own document vault, such as a medical
  certificate) is needed.
- Days are priced under the employee's office calendar (`services/workingDays.js`). With the
  sandwich rule, the weekend between two approved leaves is charged to the one approved second,
  and given back if the other is cancelled or shortened (`services/leaveRequestPricing.js`).
  Operations that price or give back these charges (approving, cancelling, deciding a change)
  run one at a time per employee under a short lease (`services/leaveEmployeeLock.js`), so two
  neighbouring leaves approved at the same moment still charge the weekend exactly once.
- Submitting claims each half day (`models/LeaveDayClaim.js`, so overlapping requests are refused
  even at the same moment) and holds the days on the balance. Approval charges today's price,
  and is refused if the balance no longer covers it.
- Long leave is approved in steps: when a leave type sets `usage.hrApprovalAfterDays`, leave
  longer than that needs HR's approval after the manager's. Only the last step charges the leave;
  a decline at any step frees the days. HR may decide any step, but not two on the same request.
  A decision names its step, so one meant for a step someone has just decided is refused (409).
- Before it starts, the employee can withdraw or cancel their leave. After that they ask for a
  change (cancel it, or end it early), and the approver or HR decides.
- Without database transactions, each change locks the request with what it will write, posts
  the ledger movement under a key that can only be posted once, then commits
  (`services/leaveRequestSettlement.js`). The hourly job and `POST /api/leave/jobs/reconcile`
  finish anything a stopped server left part-way.
- The approver is emailed about new requests and change requests, and the employee about each
  decision, when SMTP is configured.
- `GET /api/leave/payroll-export?month=YYYY-MM[&changedSince=]` gives payroll each employee's
  unpaid (Loss of Pay) days in the month, and their encashments.
- The leave assistant (`POST /api/leave/assistant`) answers an employee's questions about their own
  leave through the ai-service, whose tools read `/api/internal/leave` for that employee only. It
  can propose a draft, which is checked against the leave rules here and opens the normal apply
  form; the employee sends it. The conversation stays in the browser; nothing is stored.
