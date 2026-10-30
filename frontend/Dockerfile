# syntax=docker/dockerfile:1.7
#
# Production image for the frontend: the Vite build served by unprivileged nginx on port 8080,
# which also forwards /api and /socket.io to the backend (see nginx.conf).
#
# Build:  docker build -t nsk-frontend ./frontend
# Run:    docker run -p 8080:8080 -e BACKEND_UPSTREAM=backend:5000 nsk-frontend

ARG NODE_IMAGE=node:24-bookworm-slim

# ------------------------------------------------------------------------------------------------
# Stage 1: build the static site
# ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ------------------------------------------------------------------------------------------------
# Stage 2: serve it
# ------------------------------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

LABEL org.opencontainers.image.title="frontend" \
      org.opencontainers.image.description="NSK web app served by nginx" \
      org.opencontainers.image.source="https://github.com/shivakrishna69/mutliple-agents"

# The official image substitutes environment variables into templates at start-up; only
# BACKEND_UPSTREAM is substituted, so nginx's own $variables stay intact.
ENV BACKEND_UPSTREAM=backend:5000 \
    NGINX_ENVSUBST_FILTER=^BACKEND_UPSTREAM$
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["wget", "--quiet", "--spider", "http://127.0.0.1:8080/"]
