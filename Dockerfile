# syntax=docker/dockerfile:1

# Production image for the API, worker and scheduler processes.
#
# Written because none existed: the platform this was first deployed to ("Starting
# Container...") auto-detects a Node app, runs `pnpm install` then `pnpm start`, and never
# runs `pnpm build` — so `dist/main.js` never exists and the container crash-loops on
# MODULE_NOT_FOUND. `package.json` now also carries a `prestart` hook that builds on its own,
# which fixes that failure on any platform; this Dockerfile is the other half — a real,
# reviewable build step for anyone deploying via a container registry instead of a buildpack.
#
# Debian-slim, NOT alpine: `tests/helpers/postgres.ts` and `docker-compose.yml` already made
# this call for Postgres/Redis in this repo ("Alpine/musl images fail to exec on some Docker
# Desktop + WSL2 kernels"), and native deps here (`argon2`) carry the same musl risk. One base
# image family for the whole project is one thing fewer to debug at 2am.
#
# Each stage runs its OWN `pnpm install` against the same lockfile, rather than copying
# `node_modules` between stages. pnpm workspaces lay out `node_modules` as a content-addressed
# store plus symlinks (into `packages/contracts` here); copying that tree with plain `COPY`
# risks a partial or broken symlink structure that only surfaces at container start. A second
# `pnpm install` is not a second download — BuildKit's cache mount below keeps the store warm
# across builds, so the repeat install is a filesystem operation, not a network one.

ARG NODE_VERSION=22-slim

# ── 1. Build ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

# Manifests first, so this layer (and the install below) is cached across builds that only
# change source, not dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/package.json

# Frozen lockfile: a build that could silently resolve different versions than the lockfile
# records is a reproducibility hole, not a convenience. `--mount=type=cache` keeps pnpm's
# content-addressed store across builds without baking it into any layer.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── 2. Runtime ───────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/package.json

# Production dependencies only — no TypeScript, no eslint, no vitest in the image that
# actually serves traffic. Same cache mount, so this costs nothing new to fetch.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist

# Runs as a non-root user. `node:*-slim` already ships one; reusing it rather than inventing
# a new uid/gid keeps this portable across the base image's own updates.
RUN chown -R node:node /app
USER node

# No `.env` is copied in and none is expected: a real deployment injects configuration as
# real environment variables, and `--env-file-if-exists` (see package.json) already treats a
# missing file as normal rather than fatal.

EXPOSE 8000

# `/health/live` answers before the database or Redis are reachable — see `http/routes/health.ts`
# — so this reports "the process is alive and serving", which is exactly what a container
# orchestrator's liveness probe should check. Readiness is a separate concern the orchestrator
# should probe at `/health/ready` over the network, not from inside the container.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The API process. Run migrations as a separate deploy step (`pnpm db:migrate`) before
# starting a new revision — this image never runs them itself, the same way `src/main.ts`
# never does; see its own docblock for why.
#
# The worker and scheduler processes are the SAME image with a different command — most
# platforms let a service override the container command while reusing the image:
#   worker:    node dist/workers/default.js
#   scheduler: node dist/workers/scheduler.js
CMD ["node", "dist/main.js"]
