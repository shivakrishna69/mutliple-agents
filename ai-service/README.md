# ai-service

Python 3.11 FastAPI service running the AI agents with LangGraph and Groq. Called only by the backend
(header `X-Internal-Api-Key`); it never writes to the database itself and uses the backend's internal
API for any change.

- **Support turn** (`POST /ai/process`): a supervisor routes each customer message to a billing or
  technical worker (which may call tools), answers directly, or escalates to a human.
- **Attendance regularization** (`POST /ai/attendance/regularize`): an agent checks evidence for a
  missed punch and either records it through the backend or files a review for the manager.
- **Agent telemetry**: node, model and tool timings are posted to the backend for the admin console;
  conversation content is never included.

## Run (Docker, recommended)

```bash
cp .env.example .env     # GROQ_API_KEY, AI_SERVICE_API_KEY (same as backend), BACKEND_INTERNAL_URL
docker build -t multiagent-ai-service .
docker run -d --name multiagent-ai-service --restart unless-stopped --env-file .env -p 8000:8000 multiagent-ai-service
curl http://localhost:8000/health
```

From inside the container the backend on your machine is `http://host.docker.internal:5000`.
After changing code, rebuild the image and recreate the container.

## Tests

```bash
python -m pip install -r requirements.txt -r requirements-dev.txt
python -m pytest            # about 2 seconds; no Groq key, network or backend needed
ruff check . && ruff format --check .
```

Without a local Python, run them in Docker from this folder (mounting only the code, so `.env` is
never read):

```bash
docker run --rm -v "$PWD/app:/src/app:ro" -v "$PWD/tests:/src/tests:ro" -v "$PWD/pyproject.toml:/src/pyproject.toml:ro" \
  -v "$PWD/requirements.txt:/src/requirements.txt:ro" -v "$PWD/requirements-dev.txt:/src/requirements-dev.txt:ro" \
  -w /src python:3.11-slim sh -c "pip install -q -r requirements.txt -r requirements-dev.txt && python -m pytest"
```

| File | Covers |
|---|---|
| `test_output_guard.py` | False action claims are removed or escalated; honest wording passes; lists are renumbered |
| `test_supervisor_parsing.py` | Tolerant parsing of routing decisions, and the routing edges (two replies at most per turn) |
| `test_tools.py` | Simulated tools, and the customer id always coming from the server, never from the model |
| `test_support_graph.py` | Whole support turns with scripted models: tool use, two-topic messages, guard escalation, fallbacks |
| `test_attendance_agent.py` | The evidence rule, date resolution, and full regularization conversations, including prompt injection |
| `test_api.py` | Internal API key, 422 shape, 503 without Groq, 504 on timeout |
| `test_config.py` | Unsafe settings (simulated tools or plain HTTP in production, short keys) stop the service |

`tests/fakes.py` holds the scripted chat model and in-memory attendance systems used in place of
Groq and the backend.

## Structure

```
app/main.py              FastAPI app, endpoints, error mapping, lifespan
app/agent.py             AgentRuntime: models, compiled graph, per-thread memory limits
app/graph.py             LangGraph topology (supervisor ↔ workers loop)
app/nodes/               supervisor, workers (+ tools), attendance agent
app/guards/              output guardrails
app/services/            client for the backend internal API
app/telemetry.py         LangChain callback → batched telemetry events
app/config.py            settings, validated at startup
```
