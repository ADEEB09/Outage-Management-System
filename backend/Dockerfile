# Dockerfile for the backend service.
#
# IMPORTANT: this project uses npm workspaces (backend/frontend/mobile share
# one root package-lock.json), so this image MUST be built with the repo
# ROOT as the build context, not backend/ itself -- otherwise there's no
# lockfile to install from. Build it like this, from the repo root:
#
#   docker build -f backend/Dockerfile -t oms-backend:latest .
#
# ---------- Stage 1: install & build ----------
FROM node:22-bookworm-slim AS builder

# sharp's native build needs these; without them `npm install` fails silently
# on some platforms or falls back to a slower prebuilt binary mismatch.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the root workspace manifests first (cacheable layer), then the
# backend workspace's own package.json so npm knows this workspace exists.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json

# --legacy-peer-deps: the mobile crew app (Expo/React Native) and the web
# frontend (Vite) have peer-dependency ranges that genuinely conflict with
# each other in this shared-lockfile setup -- the same conflict we resolve
# locally every time with this same flag. --omit=dev keeps devDependencies
# (types, linters, etc.) out of the production image.
# --workspace=backend scopes the install to only what the backend needs,
# so this image doesn't end up carrying React Native's dependency tree.
RUN npm ci --legacy-peer-deps --omit=dev --workspace=backend --include-workspace-root

# Now bring in the actual backend source.
COPY backend/src ./backend/src

# ---------- Stage 2: slim runtime ----------
FROM node:22-bookworm-slim AS runtime

# sharp's runtime (not just build) needs libvips -- without this the
# container starts but crashes the first time a photo is uploaded.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips42 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Run as a non-root user -- a compromised Node process shouldn't have
# root inside the container, even though the container itself is isolated.
RUN addgroup --system --gid 1001 oms && \
    adduser --system --uid 1001 --gid 1001 oms

COPY --from=builder --chown=oms:oms /app/node_modules ./node_modules
COPY --from=builder --chown=oms:oms /app/backend/node_modules ./backend/node_modules
COPY --from=builder --chown=oms:oms /app/backend/package.json ./backend/package.json
COPY --from=builder --chown=oms:oms /app/backend/src ./backend/src

WORKDIR /app/backend

USER oms

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:4000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]
