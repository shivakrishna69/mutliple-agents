# ai-service

Python 3.11 FastAPI service running the AI agents with LangGraph and Groq. Called only by the backend
(header `X-Internal-Api-Key`); it never writes to the database itself and uses the backend's internal
API for any change.

- **Support turn** (`POST /ai/process`): a supervisor routes each customer message to a billing or
  technical worker (which may call tools), answers directly, or escalates to a human.
- **Attendance regularization** (`POST /ai/attendance/regularize`): an agent checks evidence for a
  missed punch and either records it through the backend or files a review for the manager.
- **Leave assistant** (`POST /ai/leave/assistant`): answers an employee's questions about their own
  leave (balances, types and rules, requests, office holidays, what a leave costs) with read-only
  tools over the backend's internal leave API, and may prepare a draft the employee reviews and
  sends themselves. It never sends, approves or changes leave; the backend names the employee and
  checks any draft again. Needs `BACKEND_INTERNAL_URL`.
- **Department knowledge index** (`POST /ai/knowledge/chunks`, `POST /ai/knowledge/documents/remove`,
  app/knowledge/): the backend's ingestion worker sends each knowledge base document's chunks in
  batches; they are embedded on the CPU with fastembed (`BAAI/bge-small-en-v1.5`, MIT, 384
  dimensions; no text leaves the server) and stored in Qdrant, one point per chunk with its company,
  department, agent, document, access level, headings and page. Indexing a document again overwrites
  its chunks; removing evicts all of them. Searches always filter on one department. 503 when
  `QDRANT_URL` is not set or Qdrant cannot be reached; the backend retries.
- **Department agents** (`POST /ai/knowledge/answer`, app/nodes/knowledge_agent/): answer one
  employee question from one department's knowledge, with citations. The question is embedded and
  the department's `KNOWLEDGE_ANSWER_TOP_K` closest passages are found; those below
  `KNOWLEDGE_MIN_RELEVANCE` (0.5, measured: questions a document answers scored 0.64–0.89, unrelated
  ones at most 0.45) are dropped, and with none left the reply is `not_found` without calling the
  model. Otherwise the model answers from the numbered passages only and cites each fact as [n]; it
  answers what the passages cover and says what they do not, and replies NOT_FOUND only when no
  passage is relevant at all. Citations written "[Passage 2]", "[^2]" or "【2】" count as [2]. Passages and the department's guidance sit inside tags the text cannot close,
  and are declared data, not instructions (prompt injection). Then citation marks that point at no
  passage are removed and the output guard runs. A sentence that cites a passage restates the
  documents, which are often written in the company's voice ("We review requests every Tuesday",
  "The on-call engineer will investigate"), so in it only the assistant claiming an action for
  itself ("I've forwarded…") is removed; uncited sentences are guarded as before. An answer left
  without a valid citation is `refused` with a fixed reply. The response carries the outcome, the answer, the cited passages
  (document, chunk, headings, page, an excerpt of at most `KNOWLEDGE_EXCERPT_CHARS`) and the token use.
  With `"stream": true` it is sent as NDJSON as the model writes: `delta` events, then `final`
  (authoritative: it replaces the deltas) or `error`. Nothing is stored; the backend sends recent
  history (`KNOWLEDGE_ANSWER_HISTORY_MESSAGES`) and decides who may ask which agent.
- **NSK assistant** (`POST /ai/nsk/turn`, app/nodes/nsk_assistant/): one turn of the HR portal's
  assistant. The message is classified first (JSON mode: intent, sentiment, entities, a short topic);
  deterministic tone rules can only raise the sentiment (harassment or burnout -> `SENSITIVE_HR`,
  "urgent" or "!!" -> `URGENT`, "still not working" -> `FRUSTRATED`). An intent the backend did not
  allow, classified with confidence of at least 0.6, gets a fixed reply listing what the person can
  ask, and no tool runs. Otherwise the model answers with only the tools the backend listed; each
  tool call goes to the backend's `/api/internal/nsk/tools/:tool` with the turn's actor token, so the
  backend decides whose data it is and checks access again; `search_company_docs` asks the backend
  which departments the person may read and searches only those (`search_department_passages`, one
  Qdrant query with `MatchAny`). Tool results, passages and earlier sessions are numbered sources the
  reply cites as [n]. The reply is then checked: `CLARIFY:`/`NOT_FOUND:` markers set the outcome,
  marks pointing nowhere are removed, the output guard runs, and every number must appear in the
  evidence (grounding.py: digit-group commas and leading zeros ignored); sentences with other numbers
  are removed and a reply that loses too much is `refused`, as is a document answer that cites
  nothing. The three next suggestions are predicted in parallel from the intent, sentiment and recent
  conversation, limited to the allowed intents, with fixed ones when the model fails. Nothing is
  stored. Needs `BACKEND_INTERNAL_URL`.
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

The knowledge index needs Qdrant: `docker compose up` (repository root) runs one, or start one with
`docker run -d -p 6333:6333 -e QDRANT__SERVICE__API_KEY=<key> qdrant/qdrant:v1.20.0` and set
`QDRANT_URL` and `QDRANT_API_KEY` (the same key, 32+ characters). The image carries the embedding
model, downloaded and checked against app/knowledge/embedding_model.sha256 while it is built, so the
service never downloads anything (`EMBEDDING_OFFLINE=true`, required in production). It adds about
450 MB to the image and about 300 MB of memory once loaded.

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
| `test_output_guard.py` | False action claims are removed or escalated; honest wording passes; lists are renumbered; a sentence citing a source may restate the company's voice, but never claim an action for the assistant |
| `test_supervisor_parsing.py` | Tolerant parsing of routing decisions, and the routing edges (two replies at most per turn) |
| `test_tools.py` | Simulated tools, and the customer id always coming from the server, never from the model |
| `test_support_graph.py` | Whole support turns with scripted models: tool use, two-topic messages, guard escalation, fallbacks |
| `test_attendance_agent.py` | The evidence rule, date resolution, and full regularization conversations, including prompt injection |
| `test_leave_assistant.py` | Tools scoped to the backend's employee, pricing and drafting without sending, refusals and mistakes returned to the model, bounded rounds, guarded replies, the endpoint's statuses |
| `test_nsk_assistant.py` | The NSK assistant with scripted models: classification and tone rules, the number check, tool calls carrying the actor token, only allowed tools offered, a disallowed intent answered without tools, invented numbers and uncited policy refused, markers, earlier sessions as sources, refused tool calls, the urgent tone, fallbacks, suggestions, the endpoint |
| `test_api.py` | Internal API key, 422 shape, 503 without Groq, 504 on timeout |
| `test_knowledge_api.py` | The knowledge endpoints: internal key, every malformed batch refused before embedding, 503 without Qdrant |
| `test_knowledge_unit.py` | Stable point ids, headings in the embedded text, Qdrant and offline-model settings |
| `test_knowledge_agent.py` | The department agent with a scripted streaming model: no model call without relevant passages, cited answers, invented citations removed, NOT_FOUND (also split across pieces, never streamed), refusals, the output guard (answers restating documents in the company's voice are answered, not refused), citation variants, partial answers in the prompt, the prompt's tags defused, recent history only |
| `test_knowledge_answer_api.py` | `POST /ai/knowledge/answer`: internal key, invalid requests, 503 without a model or index, the JSON answer, the NDJSON stream (deltas, final, error events), 503/504 mapping |
| `test_knowledge_retrieval_eval.py` | A fixed set of handbook and Data Engineering questions (an exact heading, paraphrases) against a real Qdrant and the real model: each finds the passage that answers it above `KNOWLEDGE_MIN_RELEVANCE`; unrelated questions stay below it |
| `test_knowledge_index.py` | Against a real Qdrant and the real model (`TEST_QDRANT_URL`, `TEST_QDRANT_API_KEY`; skipped without, required in CI): collection and indexes created once even by two instances at once, overwrite, remove, department isolation, a search across several departments staying within them, the closest chunk answering a question |
| `test_config.py` | Unsafe settings (simulated tools or plain HTTP in production, short keys) stop the service |

`tests/fakes.py` holds the scripted chat model and in-memory attendance systems used in place of
Groq and the backend.

## Structure

```
app/main.py              FastAPI app, endpoints, error mapping, lifespan
app/agent.py             AgentRuntime: models, compiled graph, per-thread memory limits
app/graph.py             LangGraph topology (supervisor ↔ workers loop)
app/nodes/               supervisor, workers (+ tools), attendance agent, leave assistant, knowledge agent,
                         NSK assistant
app/guards/              output guardrails
app/services/            client for the backend internal API
app/knowledge/           department knowledge index: endpoints, embeddings (fastembed), Qdrant store,
                         the build-time model download and its checksums
app/telemetry.py         LangChain callback → batched telemetry events
app/config.py            settings, validated at startup
```
