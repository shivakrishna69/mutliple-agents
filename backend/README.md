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
| `/api/auth` | signup, login, logout, current user, password change | public / signed in |
| `/api/support`, `/api/conversations`, `/api/webhooks` | support desk | customers / staff / signed webhooks |
| `/api/admin` | users and roles | admin |
| `/api/attendance` | punch-in, AI regularization, manager reviews | employees / managers / HR |
| `/api/payroll` | tax estimates, payslips, public payslip verification | employees / HR |
| `/api/analytics` | workforce attrition and burnout | HR, admin |
| `/api/okrs` | objectives, key results, milestones | employees with a profile |
| `/api/vault` | employee documents | owner / HR / admin |
| `/api/org` | org chart and reporting lines | staff |
| `/api/people`, `/api/invitations` | onboarding by email invitation | HR, admin / public token |
| `/api/offices` | offices: location, time zone, shift, weekly offs | HR, admin |
| `/api/employees` | employee records (base office assignment) | HR, admin |
| `/api/work-calendar` | holidays and the day-by-day calendar | HR, admin edit / employees read their office |
| `/api/leave` | leave settings and types, balances, ledger, adjustments, encashments, leave job; leave requests, approvals, payroll export | HR, admin manage / employees their own / reporting managers decide their team's requests |
| `/api/internal` | calls from the AI service | internal API key |

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
  (from the employee's document vault) is needed.
- Days are priced under the employee's office calendar (`services/workingDays.js`). With the
  sandwich rule, the weekend between two approved leaves is charged to the one approved second,
  and given back if the other is cancelled or shortened (`services/leaveRequestPricing.js`).
- Submitting claims each half day (`models/LeaveDayClaim.js`, so overlapping requests are refused
  even at the same moment) and holds the days on the balance. Approval charges today's price,
  and is refused if the balance no longer covers it.
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
