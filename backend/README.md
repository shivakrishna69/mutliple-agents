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

| Script                                                                        | Purpose                                                                                                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                                                 | development server with auto-restart                                                                                                   |
| `npm start`                                                                   | production start                                                                                                                       |
| `npm run set-role -- <email> <admin\|hr\|finance\|it_admin\|agent\|employee>` | recovery tool to change a role directly in the database (always stored lowercase)                                                      |
| `npm run send-test-message`                                                   | sends a signed test message to the inbound webhook                                                                                     |
| `node scripts/reindexKnowledge.js [departmentId]`                             | puts knowledge base documents back in the queue to be indexed again (after Qdrant lost its data, or the embedding or chunking changed) |
| `node scripts/checkOfferLetterPdf.js`                                         | renders and locks a sample offer letter, to check this machine's Chromium and qpdf                                                     |
| `npm test`                                                                    | unit and integration tests (integration needs MongoDB; see [tests/README.md](tests/README.md))                                         |
| `npm run lint` / `npm run format:check`                                       | ESLint and Prettier checks                                                                                                             |

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

| Mount                                                                                            | Purpose                                                                                                                                                                                                                                                                          | Access                                                                                   |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `/api/auth`                                                                                      | signup with email confirmation, login, logout, current user, password change, forgotten password reset                                                                                                                                                                           | public / signed in                                                                       |
| `/api/support`, `/api/conversations`, `/api/webhooks`                                            | support desk                                                                                                                                                                                                                                                                     | customers / staff / signed webhooks                                                      |
| `/api/admin`                                                                                     | users and roles (only an admin grants or changes administration)                                                                                                                                                                                                                 | admin, IT administrator                                                                  |
| `/api/attendance`                                                                                | punch-in (office, home or on duty), punch-out, today's board, analytics, AI regularization, manager reviews; without a base office a punch is recorded with its location as `LOCATION_LOGGED_UNASSIGNED` (no radius or shift; closed 16 h after if left open) instead of refused | employees / managers / HR                                                                |
| `/api/presence`                                                                                  | my presence setup and notice, who is available/away/offline now, daily active hours                                                                                                                                                                                              | everyone (own) / managers / HR                                                           |
| `/api/payroll`                                                                                   | tax estimates, payslips, public payslip verification                                                                                                                                                                                                                             | employees / HR                                                                           |
| `/api/analytics`                                                                                 | workforce attrition and burnout                                                                                                                                                                                                                                                  | HR, admin                                                                                |
| `/api/dashboard`                                                                                 | the dashboard, in sections by role                                                                                                                                                                                                                                               | signed in (sections by role)                                                             |
| `/api/system`                                                                                    | the health of the AI service, email, database and cache                                                                                                                                                                                                                          | admin                                                                                    |
| `/api/okrs`                                                                                      | objectives, key results, milestones                                                                                                                                                                                                                                              | employees with a profile                                                                 |
| `/api/vault`                                                                                     | employee documents                                                                                                                                                                                                                                                               | owner / HR / admin                                                                       |
| `/api/org`                                                                                       | org chart and reporting lines                                                                                                                                                                                                                                                    | staff                                                                                    |
| `/api/company`                                                                                   | company name, short code, mail domain, logo, colours, time zone, employee ID digits                                                                                                                                                                                              | public branding / HR read / admin change                                                 |
| `/api/departments`                                                                               | departments with head counts: add, change, deactivate, remove unused                                                                                                                                                                                                             | HR, admin                                                                                |
| `/api/departments/:departmentId/agent`                                                           | the department's knowledge base: agent settings, lead picker, documents (upload, list, delete); its Questions Inbox                                                                                                                                                              | the department's head and knowledge lead, admin                                          |
| `/api/departments/agents/available`, `…/agent/chat`, `…/agent/conversations`, `…/agent/feedback` | asking department agents (answers streamed, with cited passages), conversations, feedback                                                                                                                                                                                        | the agent's audience (see below); conversations: their owner                             |
| `/api/departments/:departmentId/board`, `/task-leads`, `/sprints`, `/tasks`                      | the department's task board: sprints, tasks, comments, team leads, team work                                                                                                                                                                                                     | the department's people (leads: head, named task leads, admin)                           |
| `/api/notifications`                                                                             | in-app notifications: list, mark read                                                                                                                                                                                                                                            | signed in (each sees only theirs)                                                        |
| `/api/knowledge-bases`                                                                           | the knowledge bases this user manages, with agent status and document counts (read only)                                                                                                                                                                                         | signed in (each sees only theirs)                                                        |
| `/api/people`, `/api/invitations`                                                                | onboarding by email invitation                                                                                                                                                                                                                                                   | HR, admin / public token                                                                 |
| `/api/hr/onboarding`                                                                             | offers: CTC structure, offer letter preview, drafts reviewed before they are sent, dispatch with a locked letter and a 48-hour activation link                                                                                                                                   | HR, admin                                                                                |
| `/api/offices`                                                                                   | offices: location, time zone, shift, weekly offs                                                                                                                                                                                                                                 | HR, admin                                                                                |
| `/api/employees`                                                                                 | current employees for pickers (invited people included); base office assignment; bulk CSV import                                                                                                                                                                                 | HR, admin                                                                                |
| `/api/work-calendar`                                                                             | holidays and the day-by-day calendar                                                                                                                                                                                                                                             | HR, admin edit / employees read their office                                             |
| `/api/leave`                                                                                     | leave settings and types, balances, ledger, adjustments, encashments, leave job; leave requests, approvals, payroll export                                                                                                                                                       | HR, admin manage / employees their own / reporting managers decide their team's requests |
| `/api/internal`                                                                                  | calls from the AI service                                                                                                                                                                                                                                                        | internal API key                                                                         |

## Dashboard and service health

`GET /api/dashboard/overview?range=today|7d|30d` (default `today`) returns the signed-in person's
dashboard in sections. Each section is built only for the roles allowed to see it; the others are
`null` (`services/dashboardOverview.js`):

| Section    | Roles                           | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `people`   | HR, admin                       | attendance today (same counts as `/api/attendance/today`), presence now (`null` when switched off), leave requests and changes the viewer can decide, attendance corrections pending, headcount by department and joiners this month, the next 3 holidays                                                                                                                                                                                                           |
| `support`  | admin, agent                    | the queue now (waiting for an agent, assigned to you, with agents, with the AI); over the conversations opened in the range: share handled by the AI alone, escalation share, average first response, share within the target (`DASHBOARD_SETTINGS.FIRST_RESPONSE_TARGET_MS`, 60 s), median AI reply time; the change from the same stretch of the previous period; AI and agent replies per local hour (today) or day; the newest conversations the viewer may see |
| `accounts` | admin                           | accounts per role, new in the last 7 days, unconfirmed                                                                                                                                                                                                                                                                                                                                                                                                              |
| `me`       | anyone with an employee profile | today's attendance and punch, leave balances, pending leave requests, latest payslip, next holiday                                                                                                                                                                                                                                                                                                                                                                  |

- **Ranges are in the company's time zone** (`services/dashboardRange.js`): "today" starts at the
  company's midnight even while the server's UTC date is still yesterday, and the chart groups
  replies by local hour or day.
- **Nothing is estimated.** A figure with nothing to measure is `null`; shares are fractions 0..1,
  durations whole milliseconds. AI replies are `ai_supervisor` and `ai_worker` messages, agent
  replies `human_agent`.

`GET /api/system/health` (admins only) checks the AI service (`/health` within 2 s; 503 means
degraded), email (an SMTP check, reused for 5 minutes), the database (ping) and the cache (Redis ping
or in-memory). Each is `operational`, `degraded`, `down` or `not_configured`, with its response
time; `overall` is down when the database is. Only states and timings are returned, never hosts,
addresses or error texts.

## Attendance analytics

`GET /api/attendance/analytics?month=YYYY-MM&departmentId=<id>` (services/attendanceAnalytics.js) covers
the same people as the Today board: HR and administrators see everyone (or one department), a team
lead their direct reports, anyone else gets 403 `ANALYTICS_FORBIDDEN`. Without `month`, the company's
current month; a later month is refused (`ANALYTICS_MONTH_AHEAD`).

| Field         | What it holds                                                                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `people`      | each person's days of the month (`on_time`, `late` (half days included), `leave`, `absent`, `holiday`, `weekly_off`, `not_joined`, `upcoming`), judged by their office's calendar and approved leave; `expectedDays`, `presentDays`, `lateDays` and `completion` (present ÷ expected; `null` without a base office) |
| `departments` | the same sums per department, with headcount                                                                                                                                                                                                                                                                        |
| `arrivals`    | punch-in times over the last `ATTENDANCE_ANALYTICS.ARRIVAL_DAYS` days, in office time, counted per `ARRIVAL_SLOT_MINUTES` slot and day (busy slots only), with each day's median                                                                                                                                    |

Expected days are working days from joining to today (today only once punched in), less approved
leave (a half day counts half). A working day with a punch counts present up to what was expected of
it; a half-day leave without a punch is the other half missed (`absent`).

## Signup, email confirmation and password reset

Signing up creates an **unverified** account and emails a 6-digit code and a confirmation link; the
account cannot sign in until one of them is used (`services/accountEmailFlows.js`,
`controllers/accountEmailController.js`).

| Endpoint                                                                                                                                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/signup` `{ firstName, lastName, email, phoneCountry, phoneNumber, dateOfBirth, gender, password, confirmPassword, acceptTerms }` | 202 "check your email" with `resendAfterSeconds` and `codeDigits`; no session yet. The phone is checked for the picked country (`phoneCountry`, e.g. `IN`; India when left out) with libphonenumber-js and stored in E.164 (not verified yet). `dateOfBirth` is `YYYY-MM-DD`, at least 18 years ago; `gender` is one of the published choices. Both are checked and stored when sent, and become required with `SIGNUP_PROFILE_SETTINGS.BIRTH_DATE_AND_GENDER_REQUIRED`. The terms version and time agreed to are stored too |
| `POST /api/auth/verify-email` `{ token }` or `{ email, code }`                                                                                   | confirms the email and signs in (200, with the session)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/auth/verify-email/resend` `{ email }`                                                                                                 | a new code and link                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /api/auth/login` `{ email, password, rememberDevice }`                                                                                     | signs in; with `rememberDevice` the cookies last `REMEMBERED_SESSION_DAYS` (default 30), otherwise they end with the browser                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /api/auth/password/forgot` `{ email }`                                                                                                     | a reset email with a 6-digit code and a link, for an active account (a confirmation email for an unverified one); answers with `linkValidMinutes`                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/auth/password/reset/:token`                                                                                                            | whether a reset link still works, and until when                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/auth/password/reset` `{ token, password, confirmPassword }` or `{ email, code, password, confirmPassword }`                           | new password, with the emailed link or code; every session ends; the owner is emailed                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/auth/password-policy`                                                                                                                  | the password rules (each check's label and pattern) and the strength meter's levels, so screens show the server's own rules                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/auth/options`                                                                                                                          | `rememberedSessionDays`, `verificationCodeDigits` (confirmation and reset codes), `passwordResetLinkMinutes`; for signup `birthDateAndGenderRequired`, `minimumSignupAgeYears`, `genders` (`{ value, label }` in order), `defaultPhoneCountry` and `phoneCountries` (`{ code, name, callingCode }` by name)                                                                                                                                                                                                                  |

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
department), `role` (employee, agent; an admin also hr, finance, it_admin), `manager_email`,
`work_type` (Onsite, Hybrid, Remote), `employment_status` (Probation, Active), `office_code`,
`job_level` (a value or label, e.g. `cto` or "Team Lead"; Individual Contributor when empty) and
`employment_type` (full_time, contractor, intern; full-time when empty) are optional.

## Onboarding offers: CTC structure and offer letters

HR prepares an offer, reviews it, and only then sends it (`/api/hr/onboarding`,
`services/onboardingService.js`). Nothing reaches the candidate until a person presses dispatch.

| Endpoint                                                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET` / `PATCH /settings`                                                     | the compensation policy (Basic share, HRA rates by city, PF on full Basic, gratuity in CTC) and offer terms (probation, notice, weekly hours, shift timings, offer validity, signatory, extra clauses, the confidentiality, IP assignment and non-solicitation clauses with its months, the stock option note, the joining checklist); changes take `version`                                                         |
| `POST /calculate`                                                             | the salary structure for an offer (`annualCtc`, optional `variablePayAnnual`, `esopUnits`, `components` `{ basicAnnual, hraAnnual, specialAllowanceAnnual }`, `terms` `{ probationMonths, noticePeriodDays, offerValidUntil }`); with `includePreview`, a watermarked, unlocked letter (base64). Saves nothing                                                                                                        |
| `POST /create-draft`                                                          | saves the offer for review (`PENDING_REVIEW`) with the structure as calculated, and its terms: the settings' probation and notice unless HR set others, and its deadline (null: the settings' validity from the day it is sent)                                                                                                                                                                                       |
| `GET /drafts?status=`, `GET` / `PATCH /drafts/:id`, `POST /drafts/:id/cancel` | list, read, change while waiting for review, cancel (`version` required); each with its `lifecycle` (below) and `acceptedAt`                                                                                                                                                                                                                                                                                          |
| `POST /drafts/:id/dispatch`                                                   | recalculates and refuses (`DRAFT_FIGURES_CHANGED`) if the figures moved since review, refuses an offer whose deadline has passed (`OFFER_EXPIRED`), then creates the employee, renders the final letter, locks it and emails it with an activation link that works until the end of the deadline day (company time zone). 200 when sent; 202 when the employee exists but the email failed (dispatch again to resend) |

- **The letter has five pages**, each section starting a page (a long one continues; the footer
  counts the pages as printed): 1 the letter of appointment (role and pay at a glance, the deadline),
  2 Annexure A (the structure, variable pay, stock options), 3 terms of employment (probation, hours
  and shift, notice, the leave policy from the active leave types, further clauses), 4
  confidentiality, IP assignment and non-solicitation, 5 the joining checklist and the signature
  block. The clause and checklist texts are settings, with plain defaults
  (`ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS`) a company should have its counsel review.
- **Variable pay and a split HR sets:** `annualCtc` is the total; `variablePayAnnual` (at most
  `VARIABLE_PAY_MAX_BASIS_POINTS` of it) is set aside, and the rest, the fixed CTC, is split. HR may
  set Basic and HRA; Special allowance stays the balancing figure, so a split that cannot add up is
  refused (`SPLIT_EXCEEDS_GROSS`, or `SPLIT_DOES_NOT_ADD_UP` naming the special allowance it would
  be when HR stated another). Stock options are shown, not counted in the CTC.
- **Lifecycle**, worked out from the draft and its invitation (never stored): `INVITED` (prepared,
  not sent) → `OFFER_SENT` → `ACCEPTED` (the candidate activated their account from the offer
  email: that is how an offer is accepted) → `PROBATION` (from the joining date, for the offer's
  probation months) → `JOINED`; `WITHDRAWN` when the draft was cancelled or the invitation revoked.
- **The structure is deterministic** (`services/ctcStructure.js`), in whole rupees: Basic, HRA (by
  default 50 % in the eight cities of `HRA_FIFTY_PERCENT_CITIES`, 40 % elsewhere; both rates are
  settings), special allowance, employer PF
  (12 % up to the wage ceiling in force on the joining date), employer ESI when covered, optional
  gratuity (15/26 of a month's Basic per year), and the employee's PF, ESI, professional tax (by
  state) and income tax from the same engine as payslips (`utils/payrollCalculator.js`). Each
  figure is `{ annual, monthly, annualRemainder }`: 12 × monthly + remainder is exactly the annual
  figure. Pinned bands and 500 random CTCs are checked in `tests/unit/ctcStructure.test.js`.
- **Final letters are locked** with the candidate's date of birth as `DDMMYYYY` (AES-256 with qpdf,
  `services/pdfProtection.js`); they can be printed, not edited or copied from. Previews are never
  locked and carry `DRAFT – NOT AN OFFER`.
- **One dispatch at a time:** a draft is claimed atomically, so two clicks cannot send two offers.
  An offer cannot be sent without a signatory in the settings (`SIGNATORY_MISSING`).
- **Requirements:** a Chromium (`PDF_BROWSER_EXECUTABLE_PATH` or `PDF_BROWSER_CHANNEL`) and qpdf
  (`QPDF_PATH`, default `qpdf` on the PATH); without them previews and dispatch answer
  `PDF_UNAVAILABLE` (503). The production image installs both (`WITH_PDF_BROWSER=true`, set in
  `docker-compose.prod.yml`). `node scripts/checkOfferLetterPdf.js` renders and locks a sample
  letter, checks the password and that it prints on five pages, which is how CI tests the
  production image.
- **Email:** offers go through the configured SMTP server with the letter attached; Brevo works as
  any SMTP relay (settings in `.env.example`).

## Department knowledge bases

Each department has an AI agent (models/DepartmentAgent.js) and a knowledge base of documents its
lead uploads (models/AgentDocument.js). The API is `/api/departments/:departmentId/agent`
(routes/departmentKnowledgeRoutes.js); everything behind it goes through
services/knowledge/knowledgeBaseService.js, and a test (tests/unit/knowledgeBoundary.test.js) keeps
every other module away from the file store, chunks and vectors.

| Endpoint                                                                   | What it does                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/knowledge-bases`                                                 | every knowledge base the caller may manage (all departments for an admin, inactive ones flagged; the ones a user heads or leads; none for anyone else, as an empty list): department, agent (`null` until someone opens it; this never creates one), lead, document counts by status and the last upload, and the caller's rights |
| `GET /lead-candidates?search=`                                             | who may become the lead: active accounts of the department's employees who are not terminated, the same rule a saved lead must meet; by name, at most 50 with `hasMore`; `search` matches the name or email as plain text                                                                                                         |
| `GET /settings`                                                            | the agent: name, instructions (`systemPrompt`), `ACTIVE`/`PAUSED`, lead, limits, whether the caller may change the lead, `version`. Created on first use, named "<department> Department Agent", with the department head as lead                                                                                                 |
| `PATCH /settings` `{ name?, systemPrompt?, status?, managedBy?, version }` | changes them; `managedBy` (a user id, or null) only by an admin or the head, and only to someone the lead picker offers (an active account of a current, not terminated, employee of the department)                                                                                                                              |
| `GET /documents`                                                           | the documents, newest first: name, type, size, status, the reason a document failed, chunk count, who uploaded it                                                                                                                                                                                                                 |
| `POST /documents` (multipart, field `file`)                                | 202 with the document (`UPLOADED`); it is read and indexed in the background                                                                                                                                                                                                                                                      |
| `DELETE /documents/:docId`                                                 | evicts its chunks from the index, then deletes the stored file and the record                                                                                                                                                                                                                                                     |

**Who may use it** (services/knowledge/knowledgeAccess.js): administrators in every department; the
department head (`Department.departmentHeadId`) in their own; the knowledge lead (`managedBy`) in
theirs. Everyone else gets 403 on every endpoint, HR included, and the refusal is audited. A scope
middleware (middleware/departmentKnowledgeScope.js) loads the department and these rights once;
handlers act only on that department, so a document of another department is "not found". An
inactive department answers 409.

**Uploads** (at most 10 MB; `KNOWLEDGE_BASE_SETTINGS` in constants/validation.js holds every limit):

- The type comes from the content (services/knowledge/fileTypes.js): PDF, Word (.docx, checked as a
  real Word zip, at most 50 MB unpacked), Markdown and plain text (strict UTF-8). The extension must
  agree; what the browser declared is ignored. Refusals: 415 `UNSUPPORTED_FILE_TYPE` /
  `EXTENSION_MISMATCH`, 413, 400 `EMPTY_FILE`; 409 `DUPLICATE_DOCUMENT` (same file in the
  department), `DOCUMENT_LIMIT_REACHED` (200 per department), `AGENT_PAUSED`. Nothing is stored
  for a refused upload, and a refused user's upload is never read.
- The file is kept in MongoDB GridFS (bucket `knowledgeFiles`, services/knowledge/fileStore.js) with
  its SHA-256, checked again whenever it is read.

**Processing** (services/knowledge/ingestionRunner.js), on the same durable queue as employee imports
(services/durableQueue.js: BullMQ with `REDIS_URL`, in the backend process without; a sweep every
30 s resumes waiting and abandoned documents; `QUEUE_PREFIX` gives each deployment its own queues
when several share one Redis):

1. A worker claims the document with a lease (`PROCESSING`), so it is processed once.
2. Its text is read in a separate thread, stopped after 60 s or 256 MB (pdfjs-dist, mammoth;
   services/knowledge/extractionThread.js). Encrypted and scanned PDFs are refused: there is no OCR.
3. It is split into chunks (services/knowledge/chunking.js): within one heading and one PDF page, about
   1,200 characters, never more than 1,800, overlapping the previous chunk.
4. Its old chunks are evicted and the new ones sent to the AI service's index in batches of 16, with
   `{ companyId, departmentId, agentId, documentId, accessLevel: "DEPARTMENT" }`, headings and page.
5. `READY` with the chunk count; or `FAILED` with a reason the lead can act on
   (`KNOWLEDGE_MESSAGES.PROCESSING_FAILURES`). An unreachable index is retried, 3 attempts in all.

A document deleted or taken over while it is processed ends without stray chunks. A delete while the
index is down answers 503 and leaves the document `DELETING` until it is deleted again.

## Department agents: questions, conversations and the Questions Inbox

Employees ask a department's agent; it answers from that department's documents through the
ai-service (`POST /ai/knowledge/answer`, services/agentChat/knowledgeAnswerClient.js), citing the
passages it used. What it cannot settle goes to the department's **Questions Inbox**, where the
department's head and knowledge lead answer the asker directly.

**Who may ask** (services/agentChat/agentAudience.js). Every role has `ASK_DEPARTMENT_AGENTS`; which
agents a person may ask is set per agent. `DepartmentAgent.audience` is `FOLLOW_DEPARTMENT` (the
default), `COMPANY` or `DEPARTMENT`; following the department means the whole company when the
department is a **shared service** (`Department.isSharedService`, set by HR or an admin on the
department, for HR, IT, Finance and the like) and the department's own people otherwise, sub-units
included. Askers need an employee record that has not ended (full-time, contractors and interns
alike); the department's head, its lead and administrators may always ask, to try their agent. An
agent answers only while it is active and has at least one `READY` document.

| Endpoint                                                                                                 | What it does                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/departments/agents/available`                                                                  | the agents this person may ask, with their audience                                                                                                                                                                                |
| `POST /api/departments/:departmentId/agent/chat`                                                         | `{ question, conversationId?, stream? }`: one question. `stream: true` answers as NDJSON: `started` (the stored question), `delta` (text as it is written), then `final` (the stored answer, which replaces the deltas) or `error` |
| `GET …/agent/conversations`, `GET …/agent/conversations/:conversationId`                                 | the person's own conversations with the agent, and one with its messages                                                                                                                                                           |
| `DELETE …/agent/conversations/:conversationId`, `DELETE …/agent/conversations`                           | delete one, or all of theirs with this agent (questions already in the inbox stay there)                                                                                                                                           |
| `POST …/agent/feedback`                                                                                  | `{ messageId, rating: UP\|DOWN, comment? }` on one of the agent's answers                                                                                                                                                          |
| `GET …/agent/questions?status=`                                                                          | the Questions Inbox (head, lead, admin), with counts by status                                                                                                                                                                     |
| `POST …/agent/questions/:questionId/answer`                                                              | `{ answer, saveAsFaq?, faqQuestion? }`: closes it, adds the reply to the asker's conversation, and tells them in the app and by email                                                                                              |
| `POST …/agent/questions/:questionId/dismiss`                                                             | closes it without an answer                                                                                                                                                                                                        |
| `POST …/agent/questions/:questionId/faq`                                                                 | `{ faqQuestion? }`: saves an answered question as an FAQ entry                                                                                                                                                                     |
| `GET /api/notifications?unread=`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all` | the person's notifications (also pushed to open sessions as `NOTIFICATION_CREATED`)                                                                                                                                                |

**Asking.** A question counts against the daily quota (`AGENT_DAILY_QUESTION_LIMIT`, default 50 per
UTC day, kept in its own counter so deleting conversations does not reset it) and the per-minute rate
limit. The recent messages of the conversation (`AGENT_CHAT_SETTINGS.HISTORY_MESSAGES`) go with it.
The answer is stored with its outcome (`ANSWERED`, `NOT_FOUND`, `REFUSED`), the cited passages as
they were (document name, headings, page, a quoted excerpt; never the whole document) and the model's
token use. When the ai-service fails, nothing of the question is kept and the quota is given back.

**Escalation.** A `NOT_FOUND` or `REFUSED` answer sends the question to the inbox at once, and the
person reads that it was sent; a thumbs-down (`DOWN`) sends it too. One question per answer. The
department's head and knowledge lead are notified in the app (administrators when the department has
neither). Answering adds the reply to the asker's conversation as a `LEAD` message and notifies them
in the app and by email. **Save as FAQ** writes the question and answer as a Markdown document
(`source: FAQ`) into the knowledge base, processed and indexed like any upload, so the agent can
answer it next time; leads see and delete it with the other documents.

**Retention.** Conversations and messages are deleted 90 days after their last message
(`AGENT_CHAT_SETTINGS.RETENTION_DAYS`, MongoDB TTL indexes); closed questions a year after they were
closed; open ones stay until handled; notifications after 90 days. Every question, deletion, rating
and inbox action is audited (categories `agent_chat` and `agent_questions`) with ids and outcomes,
never the text.

## Department task boards

Each department has a Jira-style board (services/tasks/): sprints, and tasks of type `TASK`, `BUG` or
`STORY` moving through `TODO` → `IN_PROGRESS` → `IN_REVIEW` → `DONE`, with a priority, an assignee,
story points and an order within their column. Tasks are numbered per department (`ENG-12`); a
number is never reused. Every change is recorded in the task's activity (who, which field, from and
to; text fields without their content), next to its comments.

**Who may do what** (services/tasks/boardAccess.js). The board belongs to the department's people
(employee records in the department that have not ended), and nobody else, HR included. Its **leads**
are the department's head, the **task leads** the head names (`PUT /task-leads`, people in the
department; this is how a head delegates), and administrators (`MANAGE_ALL_TASK_BOARDS`).

|                                                                    | Members                                | Leads                 |
| ------------------------------------------------------------------ | -------------------------------------- | --------------------- |
| See the board, sprints, tasks, activity                            | ✓                                      | ✓                     |
| Create tasks (members: in the backlog)                             | ✓                                      | ✓, also into a sprint |
| Change title, description, type, priority, points, assignee, order | tasks they reported or are assigned to | any task              |
| Change the status (not to Done)                                    | tasks assigned to them                 | any task              |
| Mark a task done (only from In review)                             | tasks they reported                    | any task              |
| Plan a task into or out of a sprint                                | their backlog task into the active one | ✓                     |
| Create, edit, start and complete sprints                           |                                        | ✓                     |
| Comment                                                            | ✓                                      | ✓                     |
| See the team's work (`GET /tasks/metrics`)                         |                                        | ✓                     |

Tasks are assigned only to people in the department, who are notified in the app
(`TASK_ASSIGNED`, linking to `/boards/:departmentId?task=<id>`). Sprints go `PLANNING` → `ACTIVE` →
`COMPLETED`, one active at a time (a unique index enforces it even under concurrent starts);
completing a sprint sends its unfinished tasks back to the backlog, and a completed sprint takes no
more tasks. A task reaches Done only from In review (`TASK_DONE_NEEDS_REVIEW` otherwise), and only by
a lead or its reporter (`TASK_DONE_NOT_ALLOWED`): nobody approves work they were only assigned. Tasks, sprints and the board are versioned: an edit based on an old version is refused
with `STALE_VERSION`.

| Endpoint                                                    | What it does                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/task-boards`                                      | the boards the person can open: their department's and those they head, every active department's for an admin                                                                                                                                              |
| `GET /board`                                                | the department, the viewer's role and rights, the head, the task leads, the people tasks can go to, the active sprint                                                                                                                                       |
| `PUT /task-leads`                                           | `{ leadUserIds, version }`: the head (or an admin) names the task leads                                                                                                                                                                                     |
| `GET /sprints`, `POST /sprints`, `PATCH /sprints/:sprintId` | sprints with their progress; create `{ name, goal?, startDate, endDate }`; change fields or `status`, with `version`                                                                                                                                        |
| `GET /tasks?sprintId=&assignee=&status=`                    | `sprintId` an id or `backlog`; `assignee` an id, `me` or `unassigned`                                                                                                                                                                                       |
| `POST /tasks`                                               | `{ title, description?, taskType?, priority?, assigneeId?, storyPoints?, sprintId? }`                                                                                                                                                                       |
| `GET /tasks/:taskId`, `PATCH /tasks/:taskId`                | a task with its activity; change it `{ ...changes, version }` (status, `orderIndex`, assignee, fields)                                                                                                                                                      |
| `POST /tasks/:taskId/comments`                              | `{ body }`                                                                                                                                                                                                                                                  |
| `GET /tasks/metrics?sprintId=`                              | leads: each person's tasks by status and story points, the unassigned ones, the totals; for a sprint, its burndown (points still open at the end of each day so far, days in the company time zone); the backlog's open unassigned tasks, most urgent first |

All paths are under `/api/departments/:departmentId`; every change is audited (category `tasks`).

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
