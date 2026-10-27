# Nova Support

[![CI](https://github.com/shivakrishna69/mutliple-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/shivakrishna69/mutliple-agents/actions/workflows/ci.yml)

An HR portal and AI-first support desk in one platform, built for Indian companies of roughly
50–1,000 employees.

- **HR portal (HRMS):** geofenced attendance with an AI agent that fixes missed punches, Indian
  payroll and tax (FY 2026-27), signed PDF payslips with public verification, OKRs, workforce
  attrition/burnout analytics, an encrypted document vault, an org chart and email-invitation
  onboarding.
- **Support desk:** customers chat with a multi-agent AI (LangGraph + Groq); a supervisor routes each
  message to billing or technical specialists, and hands off to a human agent when needed.
- **Admin tooling:** user and role management, an audit log, and a live agent-telemetry console.

## Architecture

```
 Browser ──► frontend (React 19 + Vite, :5173)
                │  HTTPS + HttpOnly session cookie + CSRF header, Socket.IO for live events
                ▼
            backend (Node.js / Express 5, :5000) ──► MongoDB
                │  internal API key                  optional: Redis, S3, SMTP
                ▼
            ai-service (Python / FastAPI / LangGraph, :8000) ──► Groq LLM API
```

The backend owns all data and business rules; the AI service never writes to the database and
calls the backend's internal API instead. Details: [docs/architecture.md](docs/architecture.md).

| Folder | What it is | README |
|---|---|---|
| [`backend/`](backend) | REST API, auth, business rules, Socket.IO | [backend/README.md](backend/README.md) |
| [`frontend/`](frontend) | React single-page app | [frontend/README.md](frontend/README.md) |
| [`ai-service/`](ai-service) | AI agents (support routing, attendance regularization) | [ai-service/README.md](ai-service/README.md) |
| [`docs/`](docs) | Architecture and the full project overview | — |

## Quick start (local development)

**Prerequisites:** Node.js 22.12+ (24 recommended), Docker Desktop, a [Groq](https://console.groq.com) API key.

```bash
# 1. Database
docker run -d --name multiagent-mongo -p 27017:27017 -v multiagent-mongo-data:/data/db mongo:7

# 2. Configuration: copy the templates and fill in the secrets (each file documents every value)
cp backend/.env.example backend/.env
cp ai-service/.env.example ai-service/.env
cp frontend/.env.example frontend/.env
#    AI_SERVICE_API_KEY must be identical in backend/.env and ai-service/.env.

# 3. AI service (Docker)
docker build -t multiagent-ai-service ai-service
docker run -d --name multiagent-ai-service --restart unless-stopped \
  --env-file ai-service/.env -p 8000:8000 multiagent-ai-service

# 4. Backend
cd backend && npm install && npm run dev        # http://localhost:5000

# 5. Frontend (new terminal)
cd frontend && npm install && npm run dev       # http://localhost:5173
```

Open http://localhost:5173. To get the first administrator, set `BOOTSTRAP_ADMIN_EMAIL` in
`backend/.env` and sign up with that email, or promote an existing account with
`npm run set-role -- <email> admin` (from `backend/`).

Optional services switch features on when configured: S3 (document vault, payslip PDFs), SMTP
(invitation emails), Redis (multi-instance real-time and caching). Without them the app still runs:
vault and payslip endpoints answer "unavailable", HR gets invitation links to share by hand, and
real-time runs in memory on one instance.

## Run the whole stack with Docker Compose

For a demo or a production-like check, one command builds and starts everything (MongoDB, Redis,
backend, AI service, and the frontend served by nginx):

```bash
# backend/.env and ai-service/.env as in step 2 above
docker compose up --build -d     # open http://localhost:8080
docker compose logs -f backend   # follow a service's log
docker compose down              # stop (data is kept in the mongo-data volume)
```

- Only port 8080 is published; nginx forwards `/api` and `/socket.io` to the backend, so the browser
  sees a single origin. It runs alongside the development setup without port clashes.
- The compose stack has its own database volume (`nova-support_mongo-data`), separate from the
  `multiagent-mongo` development database.
- It serves plain HTTP on localhost, so the backend runs in development mode. A real deployment needs
  TLS in front, `NODE_ENV=production`, `COOKIE_SECURE=true` and https URLs (startup refuses insecure
  production settings).
- Payslip PDFs need Chromium in the backend image: build it with
  `docker compose build --build-arg WITH_PDF_BROWSER=true backend` and set
  `PDF_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium` (the image grows from about 430 MB to 1.4 GB).

## Roles

`admin` (everything incl. user management) · `hr` (people, payroll, analytics, onboarding) ·
`agent` (support console) · `customer` (support chat; also the employee role today). Employee
features additionally need an employee profile linked to the account. Every permission is enforced
by the backend; the frontend only hides what a role cannot use.

## Project status

| Area | Status |
|---|---|
| Auth, roles, audit log, rate limits | Done |
| Support desk (AI + human handoff) | Done |
| Attendance (geofence, AI regularization, manager reviews) | Done |
| Payroll tax calculator, payslip PDFs + verification | Done; monthly payroll run not yet |
| OKRs, workforce analytics, document vault, org chart, onboarding | Done |
| Leave management | In progress: offices, work calendar, leave policies and balances (accruals, carry forward, encashment) done; leave requests next |
| Linting and formatting | Done |
| Backend tests | Done (`npm test` in `backend/`) |
| AI-service tests | Done (`python -m pytest` in `ai-service/`) |
| CI (GitHub Actions: lint, format, tests, builds) | Done |
| Frontend browser tests (Playwright) | Done (`npm run test:e2e` in `frontend/`) |
| Docker images and Compose stack | Done (`docker compose up --build`) |

## Contributing

Work happens on short-lived branches, reviewed through pull requests. See
[CONTRIBUTING.md](CONTRIBUTING.md).
