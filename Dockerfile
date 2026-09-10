# Production image for the API, worker and scheduler processes.
#
# Deliberately PLAIN Docker — no BuildKit-only syntax. An earlier version of this file used
# `# syntax=docker/dockerfile:1` plus `RUN --mount=type=cache` for the pnpm store, and Railway
# rejected the image in ~2 seconds: `RUN --mount` is a parse error on a builder without
# BuildKit, and the `syntax` frontend needs its own image pull. A warm dependency cache is not
# worth a Dockerfile that only builds on some builders.
#
# `npm install -g pnpm` rather than `corepack prepare`, for the same reason: corepack verifies
# a package signature over the network and fails hard on images whose bundled signing keys are
# stale ("Cannot find matching keyid"). Plain npm has no such failure mode.
#
# Debian-slim, NOT alpine: `tests/helpers/postgres.ts` and `docker-compose.yml` already made
# this call for Postgres/Redis in this repo ("Alpine/musl images fail to exec on some Docker
# Desktop + WSL2 kernels"), and the native `argon2` dependency carries the same musl risk.
#
# Each stage runs its own `pnpm install` rather than copying `node_modules` between stages:
# pnpm lays that tree out as a store plus symlinks (into `packages/contracts` here), and
# copying it with plain `COPY` risks a broken symlink structure that only shows at container
# start.

# ── 1. Build ─────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

RUN npm install -g pnpm@10.0.0

# Manifests first, so this layer and the install below are cached across builds that change
# only source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/package.json

# Frozen lockfile: a build that could silently resolve different versions than the lockfile
# records is a reproducibility hole, not a convenience.
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── 2. Runtime ───────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN npm install -g pnpm@10.0.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/package.json

# Production dependencies only — no TypeScript, no eslint, no vitest in the image that serves
# traffic. NOTE the consequence: anything that runs through `tsx` is unavailable here, which is
# why the migrate/seed commands below point at COMPILED entrypoints under `dist/` rather than
# at the `pnpm db:migrate` script (that one is `node --import tsx src/db/migrate.ts`, and tsx
# is a devDependency).
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist

# Runs as a non-root user. `node:*-slim` already ships one; reusing it rather than inventing a
# new uid/gid keeps this portable across the base image's own updates.
RUN chown -R node:node /app
USER node

# No `.env` is copied in and none is expected: a real deployment injects configuration as real
# environment variables, and `--env-file-if-exists` treats a missing file as normal.

EXPOSE 8000

# The API process. This image never runs migrations itself, the same way `src/main.ts` never
# does — run them as a separate deploy step against the compiled entrypoint:
#
#   pre-deploy: node dist/db/migrate.js
#   seed once:  node dist/db/seed.js
#
# The worker and scheduler are the SAME image with a different command:
#   worker:    node dist/workers/default.js
#   scheduler: node dist/workers/scheduler.js
CMD ["node", "dist/main.js"]
