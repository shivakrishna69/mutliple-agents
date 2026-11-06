# syntax=docker/dockerfile:1.7
#
# Production image for the backend (Node.js + Express + Socket.IO).
#
# Build:  docker build -t nsk-backend ./backend
#         docker build --build-arg WITH_PDF_BROWSER=true -t nsk-backend ./backend   (payslip and offer letter PDFs)
# Run:    docker run -p 5000:5000 --env-file backend/.env --read-only --cap-drop ALL nsk-backend
#
# Configuration comes only from the environment at run time; .dockerignore keeps .env files out of
# the build context. NODE_ENV defaults to production, which requires secure cookies and https URLs.

ARG NODE_IMAGE=node:24-bookworm-slim

# ------------------------------------------------------------------------------------------------
# Stage 1: production dependencies only
# ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# ------------------------------------------------------------------------------------------------
# Stage 2: runtime
# ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="backend" \
      org.opencontainers.image.description="NSK API: auth, HR and support business rules, real-time events" \
      org.opencontainers.image.source="https://github.com/shivakrishna69/mutliple-agents"

# Payslips and offer letters are rendered by a headless Chromium (services/pdfGenerationService.js),
# and final offer letters are password-protected with qpdf (services/pdfProtection.js). Chromium adds
# a few hundred MB, so these tools are only installed on request; without them, payslips and offer
# letters report themselves as unavailable and everything else works.
ARG WITH_PDF_BROWSER=false
RUN if [ "${WITH_PDF_BROWSER}" = "true" ]; then \
      apt-get update \
      && apt-get install --yes --no-install-recommends chromium fonts-dejavu-core qpdf \
      && rm -rf /var/lib/apt/lists/*; \
    fi

ENV NODE_ENV=production \
    PORT=5000 \
    # Chromium keeps its config and crash-report folders here; the rest of the filesystem is
    # read-only in production (docker-compose.prod.yml mounts /tmp in memory).
    XDG_CONFIG_HOME=/tmp/.config \
    XDG_CACHE_HOME=/tmp/.cache

# Unprivileged account with a fixed UID, matching the ai-service image.
ARG APP_UID=10001
RUN groupadd --system --gid "${APP_UID}" appuser \
    && useradd --system --uid "${APP_UID}" --gid appuser --no-create-home --shell /usr/sbin/nologin appuser

WORKDIR /app
# Code and dependencies are owned by root and only readable by appuser, so a compromised process
# cannot modify them. Nothing is written to disk at run time (uploads are held in memory).
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

USER appuser
EXPOSE 5000

# /api/health answers 200 only while MongoDB is connected.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 5000) + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.js"]
