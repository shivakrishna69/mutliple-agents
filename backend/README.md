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
| `/api/internal` | calls from the AI service | internal API key |
