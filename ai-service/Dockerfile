# syntax=docker/dockerfile:1.7
#
# Production image for the ai-service (FastAPI + LangGraph + Groq).
#
# Build:  docker build -t multiagent-ai-service ./ai-service
# Run:    docker run -d -p 8000:8000 --env-file ai-service/.env \
#           --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
#           multiagent-ai-service
#
# Two stages:
#   builder  creates a virtualenv and installs requirements.txt into it. pip's download cache
#            lives in a BuildKit cache mount, so it speeds up rebuilds without ever being written
#            into an image layer. It then downloads the knowledge embedding model and checks every
#            file against app/knowledge/embedding_model.sha256 (the build fails on any difference).
#   runtime  starts again from the slim base and copies only the virtualenv, the model and the
#            application code. No compilers, pip cache, or build files reach the final image, and
#            the service never downloads anything at run time (EMBEDDING_OFFLINE).
#
# Secrets are never baked in: .dockerignore admits only requirements.txt and app/, so .env cannot
# enter the build context. Configuration (GROQ_API_KEY, AI_SERVICE_API_KEY, ...) is supplied at
# run time through the environment.

ARG PYTHON_IMAGE=python:3.11-slim

# ------------------------------------------------------------------------------------------------
# Stage 1: dependencies
# ------------------------------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1 \
    VIRTUAL_ENV=/opt/venv

RUN python -m venv "${VIRTUAL_ENV}"
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"

# Only the requirements file is copied here, so this layer is rebuilt only when dependencies change,
# not on every code edit.
COPY requirements.txt /tmp/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip \
    && pip install -r /tmp/requirements.txt

# The embedding model (about 65 MB), in a layer of its own that is rebuilt only when the model's
# pinned files change. Only the download script and what it imports are copied for it.
COPY app/__init__.py /build/app/__init__.py
COPY app/knowledge/__init__.py app/knowledge/constants.py app/knowledge/download_model.py \
     app/knowledge/embedding_model.sha256 /build/app/knowledge/
# The download writes some metadata readable by root only; the service runs as appuser, so every
# file is made readable (and nothing writable) for everyone.
RUN cd /build && python -m app.knowledge.download_model /opt/models \
    && chmod -R a+rX,go-w /opt/models

# ------------------------------------------------------------------------------------------------
# Stage 2: runtime
# ------------------------------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime

LABEL org.opencontainers.image.title="ai-service" \
      org.opencontainers.image.description="Multi-agent customer support runtime (FastAPI, LangGraph, Groq)" \
      org.opencontainers.image.source="https://github.com/shivakrishna69/mutliple-agents"

# PYTHONDONTWRITEBYTECODE: no .pyc writes, so the root filesystem can be mounted read-only.
# PYTHONUNBUFFERED: log lines reach the container log immediately.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:${PATH}" \
    APP_ENV=production \
    EMBEDDING_CACHE_DIR=/opt/models \
    EMBEDDING_OFFLINE=true \
    HF_HUB_OFFLINE=1

# Dedicated unprivileged system account with a fixed UID/GID, so orchestrators can enforce
# runAsNonRoot / runAsUser policies. No login shell and no home directory.
ARG APP_UID=10001
ARG APP_GID=10001
RUN groupadd --system --gid "${APP_GID}" appuser \
    && useradd --system --uid "${APP_UID}" --gid appuser --no-create-home --shell /usr/sbin/nologin appuser

WORKDIR /app

# Dependencies and code are owned by root and only readable by appuser: the process cannot modify
# its own code or libraries even if compromised. /app itself is handed to appuser as the spec
# requires, but nothing in it needs to be writable at run time.
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/models /opt/models
COPY app/ /app/app/
RUN chown appuser:appuser /app

USER appuser

EXPOSE 8000

# Container-level liveness check using the standard library (curl is not in the slim image).
# /health answers 503 when GROQ_API_KEY is missing, which correctly marks the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
