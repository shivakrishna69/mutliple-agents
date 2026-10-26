# Architecture

This document explains how the three services fit together and how the main flows travel through
them. For the full feature and API inventory see [project-overview.md](project-overview.md).

## Components

```
 Browser (React SPA, :5173 in dev)
    │  HTTPS JSON + HttpOnly session cookie + X-CSRF-Token;  Socket.IO for live events
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
 Groq LLM API
```

| Service | Owns | Never does |
|---|---|---|
| frontend | presentation, navigation, form validation for fast feedback | make authorisation decisions |
| backend | all data, permissions, business rules, audit log, real-time fan-out | call the LLM directly |
| ai-service | routing and reasoning over a conversation, tool selection | touch the database |

## Design rules

1. **The backend is the only writer.** The AI service changes state only through the backend's
   internal API (`/api/internal/*`, shared-secret header compared in constant time), so every write
   goes through the same validation, permission checks and audit log.
2. **The database is the source of truth; sockets only notify.** Events are emitted after a change is
   committed. A client that misses an event reloads over HTTP.
3. **Optional infrastructure degrades, it doesn't crash.** Without Redis, Socket.IO and the cache run
   in memory (single instance). Without S3, vault and payslip endpoints answer "unavailable". Without
   SMTP, HR gets the invitation link to share by hand.
4. **Configuration is validated at startup.** Missing or weak secrets, malformed URLs, or plain HTTP
   where HTTPS is required in production stop the process with a clear message.

## Backend request lifecycle

```
request ─► security headers, CORS, body limits, request id
        ─► route rate limit
        ─► authenticate (session cookie) ─► CSRF check on writes ─► role check
        ─► controller: validate input (pure validators) ─► call service ─► audit outcome
        ─► sendSuccess { message, data }  |  sendError { error: { message, code, requestId } }
```

Services throw typed errors carrying an HTTP status and a stable `code`; controllers map them to
responses, so business logic never builds HTTP replies. Concurrent edits use optimistic versioning
(`409 STALE_VERSION`) or atomic conditional updates instead of read-modify-write.

## Main flows

### Support turn

1. A customer message arrives (`POST /api/support/messages`, or a signed webhook for external channels)
   and is saved.
2. If a human agent has claimed the conversation, the AI is skipped.
3. Otherwise the backend sends recent history to `POST /ai/process`.
4. In the AI service's LangGraph graph, the **supervisor** routes to a billing or technical worker
   (each with its own tools), answers directly, or requests a human handoff. Workers return to the
   supervisor, so a message with two topics gets both answered in one turn.
5. The backend stores the reply, applies the routing outcome (for example escalation to the staff
   queue) and publishes it to the conversation's Socket.IO rooms.

### Attendance regularization

1. An employee who missed a punch chats with the regularization agent
   (`POST /api/attendance/regularize` → `POST /ai/attendance/regularize`).
2. The agent reads activity evidence through the internal API. With enough evidence it records the
   entry through the backend. Otherwise it asks a follow-up question, or files a review for the
   reporting manager.
3. Managers decide reviews in the app (`/api/attendance/regularization-reviews/:id/decision`).

### Payslip issue and verification

`POST /api/payroll/payslips` (HR/admin) runs these steps:

1. Compute the figures with the payroll calculator.
2. Render an HTML template with every value escaped.
3. Print it to PDF in a headless browser, with JavaScript disabled and network access blocked.
4. Hash the PDF with SHA-256.
5. Upload it to S3.
6. Store a `Payslip` record with an HMAC-signed verification ID.

Anyone can check a payslip at `GET /api/payroll/payslips/verify/:verificationId`. The page compares
the PDF hash and shows only masked details.

### Onboarding invitation

HR creates an invitation, and the backend stores only the SHA-256 of a random 32-byte token. The
link is emailed, valid for 7 days and usable once. Accepting it claims the invitation atomically,
creates the user and the employee profile, and rolls back if either step fails. Nobody can become an
admin by invitation, and only admins can invite HR.

### Agent telemetry

A LangChain callback handler in the AI service records node, model and tool timings. It posts them
in batches to `/api/internal/agent-telemetry/events`. The backend validates each event against an
allowlist, so no message text, tool arguments or outputs get through, then emits the events to the
admin-only `agent-telemetry` Socket.IO room.

## Real-time

- **Handshake:** Socket.IO authenticates with the session cookie and checks the request Origin.
- **Rooms:** `session:<id>`, `user:<id>`, `staff`, `conversation:<id>:staff|customer` and
  `agent-telemetry`.
- **Disconnects:** sockets close when the session expires. A role or password change disconnects all
  of that user's sockets.

## Security summary

- **Sessions:** HttpOnly cookies plus a CSRF header, server-side revocation, and bcrypt password
  hashing with a strength policy.
- **Abuse protection:** per-route rate limits, and login responses take the same time either way, so
  they don't reveal which emails are registered.
- **Audit log:** sensitive reads and writes are logged with ids and outcomes only (allowed, denied,
  rejected, failed).
- **Files:** the real type is detected from content, sizes are capped, S3 storage is server-side
  encrypted, and downloads use short-lived signed URLs.
- **Secrets:** they live only in git-ignored `.env` files and are validated at startup.

## Scaling limits today

- Rate limiters are in memory per process. Move them to Redis before running more than one backend
  instance.
- The AI service keeps conversation memory in process (LangGraph `MemorySaver`). Run a single replica,
  or move it to a persistent checkpointer, before scaling out.
