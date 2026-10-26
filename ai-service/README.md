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
