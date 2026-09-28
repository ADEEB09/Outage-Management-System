# Dockerfile for the frontend (web control room) service.
#
# IMPORTANT: this project uses npm workspaces (backend/frontend/mobile share
# one root package-lock.json), so this image MUST be built with the repo
# ROOT as the build context, not frontend/ itself. Build it like this,
# from the repo root:
#
#   docker build -f frontend/Dockerfile -t oms-frontend:latest .
#
# Multi-stage build: Vite produces a static bundle (dist/), which needs no
# Node runtime at all in production -- just a static file server. nginx is
# the standard choice: tiny image, battle-tested, handles the SPA fallback
# routing (client-side routes) with one config line.

# ---------- Stage 1: build the static bundle ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy the root workspace manifests first (cacheable layer), then the
# frontend workspace's own package.json so npm knows this workspace exists.
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json

# --legacy-peer-deps: same shared-lockfile peer-dependency conflict between
# the mobile crew app (Expo/React Native) and this Vite frontend that we
# resolve locally every time with this same flag.
# --workspace=frontend scopes the install to only what this workspace
# needs, so the image doesn't carry React Native's dependency tree.
RUN rm -f package-lock.json && npm install --legacy-peer-deps --workspace=frontend --include-workspace-root

# Now bring in the actual frontend source and build it.
COPY frontend ./frontend
RUN npm run build --workspace=frontend

# ---------- Stage 2: serve with nginx ----------
FROM nginx:1.27-alpine AS runtime

# SPA fallback: any path nginx can't find on disk (e.g. a client-side route
# like /incidents/INC-123) should still serve index.html so React Router
# can take over, instead of nginx returning a bare 404.
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]