# Contributing

## Workflow

1. Start from the latest `main`:
   ```bash
   git switch main && git pull
   ```
2. Create one branch per task, never commit to `main` directly:
   ```bash
   git switch -c feature/leave-management
   ```
   | Prefix | Use for |
   |---|---|
   | `feature/` | a new capability |
   | `fix/` | a bug fix |
   | `test/` | tests only |
   | `docs/` | documentation |
   | `refactor/` | restructuring without behaviour change |
   | `chore/` | tooling, dependencies, CI |
3. Commit in small, single-purpose steps. A commit message has a short imperative subject
   (≤ 72 characters) and, when useful, a body explaining *why*:
   ```
   Add leave balance accrual job

   Credits each employee's monthly accrual on the 1st, capped by the
   policy's maximum balance, so balances no longer need manual updates.
   ```
4. Write or update tests in the same branch as the code they cover.
5. Before pushing, run the checks for every service you changed and make sure no secrets are staged
   (`.env` files are git-ignored; only `*.env.example` templates are tracked):
   ```bash
   cd backend && npm run lint && npm run format:check && npm test
   cd frontend && npm run lint && npm run format:check && npm run build && npm run test:e2e
   cd ai-service && ruff check . && ruff format --check . && python -m pytest
   ```
6. Push and open a pull request into `main`. The description says what changed, why, how it was
   tested, and includes screenshots for UI changes.
7. GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the same checks on
   every pull request: backend and frontend on Node 22 and 24, the browser tests, the ai-service on
   Python 3.11, and a build and start-up check of the ai-service Docker image. Merge only when
   every check is green; then delete the branch.

## Code conventions

- **Backend layering:** route → controller (validate, check permission, audit, map errors) →
  service (business logic) → model. Validators are pure functions.
- **User-facing text** lives in `backend/constants/messages.js`; limits in `constants/validation.js`
  and `constants/rateLimits.js`.
- **Responses** use `sendSuccess` / `sendError` / `sendCodedError`; services throw typed errors with
  an HTTP status and a stable `code`.
- **Every protected operation is authorised on the backend**, and sensitive reads/writes are audited
  with ids and outcomes only (never salaries, message text or tokens).
- **Concurrency:** use optimistic versioning (409 on stale writes) and atomic conditional updates;
  don't assume MongoDB transactions.
- **Frontend:** pages compose components; data access goes through `src/api/*` and
  `useApiResource`; UI is built from `src/components/ui.jsx`.
- **Secrets** only in `.env` files, validated at startup; never in code, logs or commits.
