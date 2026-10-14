# Harness Nexus — server image.
#
# Multi-stage build:
#   - `build`    installs all deps (+ toolchain for better-sqlite3), compiles TS,
#                and runs `pnpm deploy` to extract a self-contained, prod-only
#                server directory with workspace symlinks dereferenced.
#   - `runtime`  ships only that directory + the data volume. No source, no
#                devDeps, no compilers.
#
# Base is Debian slim (glibc), NOT alpine: @node-rs/argon2 and better-sqlite3
# ship/built napi binaries against glibc. Switching to alpine would force musl
# rebuilds of both.

# ---- build stage ------------------------------------------------------------
# Node 22 (>=22.19.0 = the server engine floor, #50): the server embeds pi
# packages whose floor is 22.19. The five published npm packages keep >=20.
FROM node:22-bookworm-slim AS build

# Switch apt to a CN mirror so the toolchain install needs no proxy. The base
# image's sources.list points at deb.debian.org, which may be slow/unreachable
# from CN networks. TUNA mirrors the same Debian repos.
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources

# better-sqlite3 compiles from source at install time; @node-rs/argon2 falls
# back to source on uncommon arches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# corepack ships the pnpm version pinned in package.json (`packageManager`).
# Enable first, then COPY package.json so corepack resolves the pinned pnpm
# version (9.12.0) instead of fetching the latest, which may require a newer
# Node than the base image ships.
RUN corepack enable
WORKDIR /repo
COPY package.json ./

# Point pnpm at a CN npm registry mirror so dependency install needs no proxy.
# Set here (not in .npmrc) so it only affects the build stage; the runtime
# stage makes no registry calls. COREPACK_NPM_REGISTRY (no trailing slash!)
# pins corepack's own pnpm download to the same mirror.
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN pnpm config set registry https://registry.npmmirror.com/

# 1) Manifests + lockfile first → cacheable unless deps change.
#    Every workspace package.json must be present for `pnpm install` to resolve.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/core/package.json      packages/core/
COPY packages/shared/package.json    packages/shared/
COPY packages/sdk-ts/package.json    packages/sdk-ts/
COPY packages/server/package.json    packages/server/
COPY packages/mcp-runtime/package.json packages/mcp-runtime/
COPY packages/cli/package.json       packages/cli/
COPY apps/web/package.json           apps/web/
RUN pnpm install --frozen-lockfile

# 2) Source + shared compiler config (changes often → separate layer).
COPY tsconfig.base.json ./
COPY packages/ packages/

# Build in dependency order: server's composite project references need the
# core/shared/sdk dist/ outputs to exist first.
RUN pnpm --filter @harness-nexus/core run build \
 && pnpm --filter @harness-nexus/shared run build \
 && pnpm --filter @harness-nexus/sdk run build \
 && pnpm --filter @harness-nexus/mcp-runtime run build \
 && pnpm --filter @harness-nexus/server run build

# 3) Extract a self-contained, prod-only server directory. `pnpm deploy`
#    dereferences workspace symlinks and omits devDependencies — pnpm's
#    recommended Docker pattern. Output: /deploy/server/{dist,node_modules,package.json}.
RUN pnpm deploy --filter=@harness-nexus/server --prod /deploy/server

# ---- runtime stage ----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Sensible production defaults; JWT_SECRET is deliberately NOT set here —
# config.ts refuses to boot without it (≥16 chars), so it MUST come from the
# runtime environment (env_file / -e / compose secrets).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    LOG_LEVEL=info \
    DATA_DIR=/data \
    SQLITE_PATH=/data/harnessnexus.sqlite

WORKDIR /app
COPY --from=build /deploy/server ./

RUN mkdir -p /data

# SQLite lives here by default. Mount a named/host volume to persist across
# restarts; otherwise the container's writable layer holds it.
VOLUME ["/data"]

EXPOSE 8080
STOPSIGNAL SIGTERM

# Liveness probe via the /healthz route. Uses node (always present) instead of
# curl to avoid adding a package to the runtime image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
