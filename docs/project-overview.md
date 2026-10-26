# Nova Support: Project Overview (context for an AI assistant)

> Purpose of this document: give an AI model complete, accurate context about this codebase so it can
> answer questions, plan features, or write code that fits the existing design. It describes what
> exists today (as of October 2026), how the parts connect, the conventions to follow, and the known
> gaps. It contains no secrets.

---

## 1. What the product is

**Nova Support** is a single web platform that combines two products for small and mid-size Indian
companies (roughly 50–1,000 employees):

1. **AI-first customer support desk.** Customers chat with the company. A multi-agent AI (LangGraph +
   Groq LLM) answers first: a supervisor routes each message to a billing or technical specialist,
   which may call tools. When the AI cannot help, the conversation is handed to a human support agent
   who continues it in a live console.
2. **HRMS (HR management system) for the company's own employees.** Geofenced attendance with an AI
   agent that fixes missed punches, Indian payroll and tax (FY 2026-27 rules), signed PDF payslips with
   public verification, OKR goal tracking, workforce attrition and burnout analytics, an encrypted
   document vault, an org chart, and email-invitation onboarding.

An admin-only **agent telemetry console** shows the AI agents working live (routing, model latency,
tool calls, retrieval confidence) without exposing conversation content.

Target buyers: IT/software companies and startups, BPOs and customer-support centres, and growing
Indian businesses that currently use spreadsheets plus a separate helpdesk. Built-in Indian rules:
income-tax old vs new regime, EPF, ESI, professional tax (Karnataka, Maharashtra), and 50% HRA cities.

---

## 2. Architecture

```
 Browser (React SPA, :5173 in dev)
    │  HTTPS JSON + HttpOnly session cookie + CSRF header;  Socket.IO for live events
    ▼
 Backend API (Node.js / Express 5, :5000) ──── MongoDB (Mongoose)
    │   • auth, roles, audit log, rate limits        • optional Redis (Socket.IO adapter, cache)
    │   • all business rules live here               • optional S3 (vault files, payslip PDFs)
    │   • internal API for the AI service            • optional SMTP (invitation emails)
    │
    │  POST /ai/process, /ai/attendance/regularize   (X-Internal-Api-Key)
    ▼
 AI service (Python FastAPI + LangGraph + Groq, :8000, runs in Docker)
    │  calls back: POST /api/internal/...   (attendance writes, telemetry events)
    ▼
 Groq LLM API (model: openai/gpt-oss-120b by default)
```

Key design rules:
- **The backend owns all data and business rules.** The AI service never writes to MongoDB; it calls
  the backend's internal API (shared-secret header `X-Internal-Api-Key`, compared with HMAC + timing-safe equality).
- **The database is the source of truth; sockets only carry notifications** of changes already committed.
  A client that misses an event reloads over HTTP.
- **Optional infrastructure degrades gracefully:** no Redis means an in-memory Socket.IO adapter (single
  instance); no S3 means the vault and payslip endpoints answer "unavailable"; no SMTP means invitation
  links are shown to HR to share manually.

---

## 3. Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, React Router 8, Vite 8, Tailwind CSS v4 (via `@tailwindcss/vite`), socket.io-client |
| Backend | Node.js 24 (ES modules), Express 5, Mongoose 8, Socket.IO 4 (+ optional Redis adapter), jsonwebtoken, bcryptjs, multer, nodemailer, AWS SDK v3 (S3, lib-storage, presigner), playwright-core (headless Chromium/Edge for PDF rendering) |
| AI service | Python 3.11, FastAPI, Uvicorn, LangGraph 1.x, LangChain-core 1.x, langchain-groq, Pydantic 2, httpx |
| Data | MongoDB 7 (Docker container `multiagent-mongo`) |
| Optional | Redis, AWS S3 (or S3-compatible), SMTP server |

---

## 4. Repository layout

```
multiagent-tool/
├── backend/
│   ├── server.js                # config loading/validation, app + middleware, routes, startup/shutdown
│   ├── constants/               # messages.js (all user-facing text), validation.js, rateLimits.js, httpStatus.js
│   ├── models/                  # Mongoose schemas (see §6)
│   ├── controllers/             # HTTP handlers (thin; validation + permission + service call + audit)
│   ├── services/                # business logic (payslip pipeline, OKRs, invitations, telemetry, risk…)
│   ├── routes/                  # Express routers, one per area
│   ├── middleware/              # authMiddleware (protect), requireRole, rateLimiter, vaultUpload, webhookSignature, requireInternalApiKey
│   ├── validators/              # pure input validators returning { isValid, sanitizedInput | validationErrors }
│   ├── utils/                   # apiResponse, auditLogger, logger, socketManager, payrollCalculator, s3Client, authCookies, authToken…
│   └── scripts/                 # setUserRole.js, sendTestMessage.js (seedDemoData.js is local-only, git-ignored)
├── ai-service/
│   ├── app/main.py              # FastAPI app, endpoints, error mapping
│   ├── app/agent.py             # AgentRuntime: models, graph, thread registry, turn execution
│   ├── app/graph.py             # LangGraph topology (supervisor ↔ workers loop)
│   ├── app/nodes/               # supervisor.py, workers.py (billing/tech + tools), attendance_agent.py, attendance_worker.py
│   ├── app/guards/output_guard.py
│   ├── app/services/backend_client.py   # HTTP client for the backend internal API
│   ├── app/telemetry.py         # LangChain callback → batched telemetry events → backend
│   └── Dockerfile
└── frontend/src/
    ├── App.jsx                  # route table (lazy-loaded workforce pages)
    ├── api/                     # httpClient.js (fetch wrapper, ApiError), one module per area
    ├── auth/AuthContext.jsx     # session state, CSRF token, sign-out
    ├── components/              # AppShell (sidebar), RouteGuards, ui.jsx (design primitives), analytics/*, AgentTelemetryConsole…
    ├── hooks/                   # useApiResource, useSocket, useAgentTelemetry
    ├── pages/                   # one file per screen (§8)
    └── constants/               # routes.js (paths, roles), messages, socketEvents
```

---

## 5. Roles and permissions

Roles (stored on `User.role`): **admin**, **hr**, **agent**, **customer**.
- `customer` doubles as the **employee** role today (there is no separate "employee" role; the UI labels
  it "Employee" in onboarding but badges show "Customer").
- **Staff** = admin + agent (support console, org chart).
- Employee features (attendance, payslips, OKR editing, vault) also require an **EmployeeProfile**
  linked to the user. Roles control *what you may do*; the profile says *who you are in the company*.

| Capability | admin | hr | agent | customer/employee |
|---|---|---|---|---|
| Support chat (as a customer) | | | | ✓ |
| Support console (claim/reply to escalated chats) | ✓ | | ✓ | |
| Users & roles management | ✓ | | | |
| Agent telemetry console | ✓ | | | |
| Organisation chart | ✓ | | ✓ | |
| Onboarding / invitations | ✓ (can invite HR) | ✓ (employees, agents) | | |
| Workforce risk analytics | ✓ | ✓ | | |
| Company OKRs (create/manage) | ✓ | ✓ | | |
| Team OKRs | department heads (by `Department.departmentHeadId`) | | | |
| Issue payslips / view anyone's | ✓ | ✓ | | |
| Own attendance, payslips, tax planner, vault | if profile | if profile | if profile | if profile |
| Approve attendance reviews | ✓ (all) | ✓ (all) | | reporting managers (their reports) |

Frontend route guards only steer navigation; **every API call is authorised again on the backend**.

---

## 6. Data models (MongoDB / Mongoose)

| Model | Purpose / key fields |
|---|---|
| `User` | name, email (unique), password (bcrypt, `select:false`), role |
| `RevokedSession` | revoked session ids (logout / password change) |
| `Conversation` | customerId, status (`unassigned`, `processing-ai`, `escalated-to-human`, `assigned-agent`), currentActiveWorker (`supervisor`, `billing_agent`, `tech_agent`, `attendance_agent`, `human`), assignedAgentId |
| `Message` | conversationId, senderType (customer / ai_supervisor / ai_worker / agent), text, toolExecutionLogs, externalMessageId (idempotency) |
| `Department` | name, code, budgetCode, departmentHeadId → EmployeeProfile, parentDepartmentId |
| `EmployeeProfile` | userId (1:1), organizationData {designation, departmentId, reportingManagerId (self-ref), officeLocationId, workLocationType Onsite/Hybrid/Remote, dateOfJoining, employmentStatus Probation/Active/Notice/Terminated}, biometricMetadata {allowedGeofenceRadius, registeredDeviceMacAddress}, advancedMetrics {attritionRiskIndex, currentBurnoutScore, computedAt, modelVersion} (select:false) |
| `OfficeLocation` | geofence centre (WGS-84) and radius |
| `Attendance` | employeeId, date, checkInTime, coordinates, calculationStatus (Normal/Late/Half_Day/Absent), lateByMinutes, geofence {enforced, distanceMeters, allowedRadiusMeters} |
| `RegularizationReview` | an AI-escalated attendance correction for a manager: date, claimedPunchInTime, reason, routingReason, status Pending/Approved/Rejected, decision |
| `DocumentVault` | employeeId, documentType (Offer_Letter, Appraisal_Doc, Gov_ID), S3 key, sha256, status Pending_Verification/Verified, accessibleRoles |
| `Payslip` | employeeId, period, revision, status Issued/Superseded, earnings[], deductions[], net pay, taxSummary, verification {verificationId, contentHmac}, storage {s3Key, sha256} |
| `Objective` | OKR objective: level company/team, period {year, quarter}, parentObjectiveId, departmentId, ownerEmployeeId, status active/archived |
| `KeyResult` | objectiveId, unit (percent/count/currency_inr/score), start/target/currentValue, weight 1–10, milestones[], checkIns[] |
| `EmployeeInvitation` | email, name, role, profileDraft (job details), tokenHash (SHA-256 only), expiresAt (7 days), status pending/accepting/accepted/revoked |

Integrity patterns used throughout: `select:false` for sensitive fields, `optimisticConcurrency` (stale
writes → HTTP 409), partial unique indexes (e.g. one issued payslip per month, one open invitation per
email), `pre('validate')` reference checks, and guards that block hierarchy changes via raw query updates.

---

## 7. Features and API

All responses use `{ message, data }` on success and `{ error: { message, code?, details?, requestId, context? } }` on failure.

### 7.1 Authentication
- `POST /api/auth/signup` (self-signup → role customer; `BOOTSTRAP_ADMIN_EMAIL` becomes admin), `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/password`.
- Session = JWT in an **HttpOnly cookie** plus a **CSRF token** returned in the body and sent as `X-CSRF-Token` on writes. Login rate-limited (30 / 15 min per IP; 5 / 15 min per IP+email). Timing-equalised responses hide which emails exist.

### 7.2 Customer support (AI multi-agent)
- Customer web chat: `POST /api/support/messages`. External channels: `POST /api/webhooks/incoming` (HMAC-signed).
- Pipeline: save message → if a human owns the conversation, stop → else call ai-service `/ai/process` with recent history → store the reply → apply routing (continue with a worker, or escalate to a human) → publish via Socket.IO.
- Staff console: `GET /api/conversations`, `GET /:id/messages`, `POST /:id/claim`, `/release`, `/messages`.
- **AI graph** (ai-service/app/graph.py): `supervisor` routes → `billing_agent` (tool `check_invoice_status`), `tech_agent` (tool `query_system_logs`), `supervisor_response`, `attendance_regularization`, or `human_handoff`; workers return to the supervisor so one message with two topics gets both answered. Tools are simulated outside production (`SIMULATED_TOOLS_ENABLED`). Conversation memory: LangGraph MemorySaver with per-thread locks, compaction and idle eviction.

### 7.3 Attendance
- `POST /api/attendance/punch-in` { lat, lng, accuracyMeters, deviceFingerprint, macAddress? }: checks employment status, registered device, GPS accuracy and office geofence; computes Late etc.
- `POST /api/attendance/regularize` { message, startNew }: chat with the **AI regularization agent**, which checks activity evidence and either records the entry (via the backend internal API), asks a follow-up question, or files a `RegularizationReview` for the reporting manager.
- `GET /api/attendance/regularization-reviews?status=`, `POST /regularization-reviews/:id/decision` { decision approve|reject, punchInTime, note }.

### 7.4 Organisation
- `GET /api/org/hierarchy` (forest of the reporting tree, cached snapshot), `GET /api/org/manager/:id` (direct and indirect reports). Staff only.

### 7.5 Payroll and tax (India, FY 2026-27)
- `utils/payrollCalculator.js computeTaxLiability(...)`: computes **both regimes** and recommends one.
  - New regime: slabs (0–4L nil … >24L 30%), standard deduction ₹75k, s.156 rebate up to ₹12L with marginal relief.
  - Old regime: standard deduction ₹50k, HRA exemption (50% cities), 80C-style caps, rebate up to ₹5L.
  - Common: surcharge with marginal relief, 4% cess, EPF (12%, wage ceiling change on 17 Sep 2026), ESI (0.75%, ceilings, daily-wage exemption), professional tax (KA, MH).
- `GET /api/payroll/rules`, `POST /api/payroll/tax-estimate` (nothing stored).
- **Payslip pipeline** (HR/admin): `POST /api/payroll/payslips` → figures → escaped HTML template → headless browser PDF (JS disabled, network blocked) → SHA-256 → S3 upload (`company-payslips/YYYY/MM/`) → `Payslip` record with HMAC verification ID `PS-YYYYMM-XXXX-XXXX-XXXX-XXXX`. Reissue creates a new revision and supersedes the old one.
- `GET /api/payroll/payslips` (own; HR/admin any), `GET /payslips/:id/download` (60-second signed URL), **public** `GET /api/payroll/payslips/verify/:verificationId` (masked name, net pay, document SHA-256).

### 7.6 Workforce analytics (attrition and burnout)
- `GET /api/analytics/workforce-risk?departmentId=&band=&sortBy=attrition|burnout&limit=`: HR/admin only and audited. Bands: unscored / safe (<40) / elevated (40–69) / critical (≥70); the worse of the two metrics sets the overall band.
- `POST /api/internal/analytics/employee-scores` writes scores from a model. **Important gap: no scoring model exists yet**; scores currently come from demo data.

### 7.7 OKRs
- `GET /api/okrs/alignment?year=&quarter=`: tree of company objectives → team objectives grouped by department → key results → milestones, with server-computed `progress` (weighted), `alignedProgress`, `rollupProgress`, and per-node `canUpdate` / `canManage` flags.
- Writes: create/patch objectives, add key results, `PATCH /key-results/:id/progress` { currentValue | progressPercent, note, version }, add/patch milestones. All writes carry `version` → 409 `STALE_VERSION` on conflict.

### 7.8 Document vault
- `POST /api/vault/documents` (multipart: file, employeeId, documentType, accessibleRoles comma-separated); PDF/JPEG/PNG ≤ 10 MB, real type detected from content.
- `GET /api/vault/employees/:employeeId/documents` (`me` alias), `GET /api/vault/download/:id` (signed URL), `PATCH /api/vault/documents/:id/verify` (HR/admin). S3 with server-side encryption; every access audited.

### 7.9 Onboarding by email invitation
- HR/admin: `GET /api/people/invitations/options`, `GET /api/people/invitations?status=`, `POST /api/people/invitations`, `POST /:id/resend` (new link, old one dies), `POST /:id/revoke`.
- Public: `GET /api/invitations/:token` (preview), `POST /api/invitations/:token/accept` { password } → atomically creates the User and EmployeeProfile, then signs the person in.
- Token: 32 random bytes (base64url), only its SHA-256 is stored; valid 7 days; atomic claim prevents double use; rollback on failure. HR may invite employees and agents; only admins may invite HR; nobody becomes admin by invitation. Email via SMTP (nodemailer); without SMTP the link is returned to HR.

### 7.10 Agent telemetry
- ai-service `app/telemetry.py`: a LangChain callback handler, bound per turn through a context variable, records node start/end, model calls (latency, tokens, tokens/s), tool start/end, retrieval (documents, relevance scores). Events go into a bounded queue and are posted in batches to `POST /api/internal/agent-telemetry/events`.
- Backend validates every event against a strict allowlist (**no message text, tool arguments or outputs**) and emits it to the admin-only Socket.IO room `agent-telemetry`: `AGENT_THINKING_EVENT`, `TOOL_EXECUTION_STARTED`, `TOOL_EXECUTION_COMPLETED`. Clients subscribe with `SUBSCRIBE_AGENT_TELEMETRY`.

### 7.11 Real-time (Socket.IO)
Cookie-authenticated handshake with an Origin check. Rooms: `session:<id>`, `user:<id>`, `staff`, `conversation:<id>:staff|customer`, `agent-telemetry`. Server events: `NEW_MESSAGE`, `CONVERSATION_STATUS_UPDATED`, `CONVERSATION_ACCESS_REVOKED`, `SESSION_ENDED`, plus the telemetry events. Heartbeat 25 s / 20 s; sockets end at session expiry; role or password changes disconnect a user's sockets.

---

## 8. Frontend screens

| Path | Screen | Who |
|---|---|---|
| `/login`, `/signup` | Auth | signed out |
| `/dashboard` | Overview | all |
| `/account` | Profile and password | all |
| `/support` | Customer support chat | customers |
| `/console` | Support console | admin, agent |
| `/admin/users` | Users & roles | admin |
| `/admin/telemetry` | Agent telemetry console (dark terminal, live metrics) | admin |
| `/attendance` | Punch-in (GPS), AI regularization chat, manager reviews | all (needs profile) |
| `/payroll` | Tax planner, payslips, issue payslip (HR/admin) | all |
| `/analytics` | Analytics hub: Predictive risk (HR/admin), OKR canvas, Document vault | all |
| `/organisation` | Org chart and reporting lines | admin, agent |
| `/people/onboarding` | Invite employees, track invitations | admin, hr |
| `/invite/:token` | Accept invitation, set password | public |
| `/verify/payslip` | Public payslip verification (local PDF hash check) | public |

Design: white cards on slate-50, indigo/violet gradients, rounded-2xl, shared primitives in
`components/ui.jsx`, a dark sidebar (`AppShell.jsx`) filtered by role, workforce pages lazy-loaded.
Data fetching goes through `hooks/useApiResource.js` (abort on unmount, 401 → sign out).

---

## 9. Security model (summary)

- HttpOnly session cookies + CSRF header; session revocation; bcrypt passwords with a strength policy.
- Per-route rate limits (in-memory today; move to Redis before running several instances).
- Central audit logging (`utils/auditLogger.js`, outcomes allowed/denied/rejected/failed) on sensitive reads and writes.
- Internal API protected by a shared secret; telemetry content allowlisted on the receiving side.
- Files: magic-byte type detection, size caps, S3 SSE, short-lived signed URLs.
- Payslips: HMAC-signed verification IDs, SHA-256 of the PDF, tamper detection.
- Invitations: hashed tokens, single use, expiry, `Referrer-Policy: no-referrer`.
- Secrets only in `.env` files (git-ignored); config is validated at startup (minimum lengths, secrets must differ, https required in production).

---

## 10. Configuration (environment variables, names only)

**Backend (`backend/.env`)**
- Core: `NODE_ENV`, `PORT`, `MONGO_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `COOKIE_SECURE`, `TRUST_PROXY_HOPS`, `CORS_ORIGINS`, `LOG_LEVEL`
- AI service: `AI_SERVICE_URL`, `AI_SERVICE_TIMEOUT_MS`, `AI_SERVICE_API_KEY`
- Misc: `WEBHOOK_SIGNING_SECRET`, `BOOTSTRAP_ADMIN_EMAIL`, `REDIS_URL`
- Storage: `VAULT_S3_*` (bucket, region, SSE, KMS key, endpoint), `PAYSLIP_S3_*`, `AWS_REGION`
- Payslips: `COMPANY_LEGAL_NAME`, `COMPANY_REGISTERED_ADDRESS`, `COMPANY_BRAND_COLOR`, `PAYSLIP_SIGNING_SECRET`, `PAYSLIP_VERIFICATION_BASE_URL`, `PDF_BROWSER_EXECUTABLE_PATH` / `PDF_BROWSER_CHANNEL`
- Email and links: `APP_PUBLIC_URL`, `COMPANY_NAME`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`

**AI service (`ai-service/.env`)**: `AI_SERVICE_API_KEY`, `GROQ_API_KEY`, `GROQ_MODEL`, `LLM_*` (timeout, retries, temperature, max tokens, reasoning effort), `AI_PROCESS_TIMEOUT_SECONDS`, `BACKEND_INTERNAL_URL`, `SIMULATED_TOOLS_ENABLED`, `AGENT_TELEMETRY_ENABLED`, `REGULARIZATION_GROQ_MODEL`, thread-memory limits.

**Frontend**: `VITE_API_BASE_URL` (empty in dev; the Vite proxy forwards `/api` and `/socket.io` to `VITE_BACKEND_PROXY_TARGET`, default `http://localhost:5000`).

---

## 11. Running locally

1. Start Docker Desktop; then `docker start multiagent-mongo` (the `multiagent-ai-service` container restarts on its own).
2. Backend: `cd backend && npm run dev` (Node `--watch`, port 5000).
3. Frontend: `cd frontend && npm run dev` (Vite, port 5173). Open http://localhost:5173.
4. Demo data (local only): `node --env-file=.env scripts/seedDemoData.js [--link <email> ...]` creates a demo company (departments, hierarchy, risk scores, Q4 OKRs, pending attendance reviews); `--remove` deletes exactly what it created. Demo accounts use the domain `demo.novasupport.in`.

Testing approach used so far: end-to-end scripts against an isolated backend and a throwaway database (HTTP + Socket.IO + Playwright with Microsoft Edge), local S3 (S3Mock) and SMTP (Mailpit) stand-ins, plus a real Groq-backed turn for telemetry.

---

## 12. Engineering conventions (follow these when changing code)

- Production-grade only: no placeholders or mock shortcuts in product code; descriptive names; thorough error handling; header comments explaining design decisions.
- Backend layering: route → controller (validate, check permission, audit, map errors) → service (business logic) → model. Validators are pure functions.
- All user-facing strings live in `backend/constants/messages.js`; limits in `constants/validation.js` / `rateLimits.js`.
- Use `sendSuccess` / `sendError` / `sendCodedError`; services throw typed errors (e.g. `OkrError`, `InvitationError`) with `httpStatus` + `code`.
- Concurrency: optimistic versioning (409 on stale writes), atomic `findOneAndUpdate` claims, partial unique indexes; no Mongo transactions assumed.
- Privacy: never log salary figures, message text or tokens; audit events record ids and outcomes.
- Frontend: pages compose panels; data access through `api/*` modules and `useApiResource`; UI built from `components/ui.jsx`; role-aware navigation in `AppShell.jsx`.
- Workflow preference: build the backend with tests first, the frontend after; commit only when asked, after a secret scan.

---

## 13. Current limitations and gaps

- **No leave management** (apply/approve leave, balances, holidays): the biggest HRMS gap.
- **No monthly payroll run** for everyone (payslips are issued one at a time); no Form 16 or PF/ESI filing files.
- **Attrition/burnout scores have no producer**: the ingestion endpoint exists, the model does not.
- No admin screens for **office locations / geofences, device registration, or departments**.
- No separate **employee** role (employees use `customer`).
- Rate limiter and caches are **in-memory**: Redis is needed before running more than one backend instance.
- Vault and payslip PDFs need **S3** configured; invitations need **SMTP** to send real email.
- No retrieval (vector) store yet; the telemetry console already displays retrieval confidence when one is added.

---

## 14. Planned / proposed advanced features

1. **Leave management + Redis job queue + notification centre** (foundation).
2. **WhatsApp HR assistant via Twilio**: punch-in by sharing location, attendance corrections via the existing AI agent, payslips on request, one-tap manager approvals.
3. **Manager weekly AI digest** (email/WhatsApp): attendance anomalies, pending approvals, lagging OKRs, risk changes.
4. **Real attrition/burnout model** from attendance trends, regularization frequency, OKR stagnation, tenure and leave, with AI-written explanations for HR.
5. **Smart OKRs**: AI-drafted key results, trajectory forecasts, WhatsApp check-in reminders.
6. **One-click payroll run** with attendance/leave-linked deductions, automatic payslip delivery, a tax-saving assistant, compliance calendar.
7. **Onboarding autopilot**: checklists, document requests, buddy assignment, AI-generated offer letters through the existing PDF pipeline.
8. **"Ask HR" policy assistant** (retrieval over company policies, Redis vector search).
9. **Voice attendance via Twilio** for workers without smartphones.
10. **Attendance fraud detection** (shared devices, impossible GPS jumps, geofence-edge patterns).
11. **No-code automation rules** ("late 3× in a week → notify manager").

Constraints to respect: India's DPDP Act 2023 (consent and transparency for location and analytics
data), AI recommends while humans decide on people decisions, and WhatsApp per-conversation costs.
