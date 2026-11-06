# Harness Nexus client image — the one-command client box (#28) and a
# persistent machine container (#118).
#
# Box mode (default): the `hnx` CLI and the official MCP Inspector, pointed at
# any Harness Nexus server via env (HNX_SERVER / HNX_TOKEN / HNX_PROFILE); the
# public demo is this image with HNX_SERVER=https://demo.harness-nexus.com.
# Disposable — run it with --rm.
#
# Machine mode (`… machine`): runs `hnx daemon`, so the container IS a machine
# of the instance. The state contract:
#   /home/box   the machine's state — mount a NAMED volume: the enrollment
#               identity + pinned adapters (~/.hnx), every agent's home
#               (skills, settings, credentials, native session history),
#               user-level installs (~/.npm-global, ~/.local) and caches.
#   /workspace  project files — bind-mount a host directory and set the
#               machine's base workspace to /workspace.
# Everything image-owned (hnx, the Inspector) stays under /usr/local, so an
# upgrade is pull + recreate with the same volume. No VOLUME instruction on
# purpose: it would discard what a derived image (FROM this one) writes under
# /home/box at build time.
#
# Build context is this directory ONLY — everything installs from npm, nothing
# from the workspace is needed. docker.yml pins CLI_VERSION to the release tag
# so the image and the npm release stay in lockstep.

FROM node:22-slim

ARG CLI_VERSION=latest

# CN mirrors for apt + npm, matching the server/web Dockerfiles: builds need
# no proxy from CN networks, and the mirrors are reachable world-wide.
# tini is PID 1: adapter process trees orphan grandchildren a node PID 1 never
# reaps, and docker stop's SIGTERM must reach the daemon. git / ssh / ps /
# python3 are the baseline coding agents reach for; anything heavier belongs
# in a derived image.
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl tini git openssh-client procps python3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm config set registry https://registry.npmmirror.com/ \
  && npm install -g @harness-nexus/cli@${CLI_VERSION} @modelcontextprotocol/inspector \
  && npm config delete registry

# The non-root user is the base image's `node` (uid/gid 1000) renamed to
# `box`: 1000 is the usual single-user Linux uid, so a bind-mounted workspace
# is writable as-is (a fresh `useradd` landed on 1001). Other hosts remap with
# HNX_UID / HNX_GID (see the entrypoint).
RUN usermod -l box -d /home/box -m node \
  && groupmod -n box node \
  && mkdir -p /home/box/.npm-global/bin /home/box/.local/bin /workspace \
  && chown -R box:box /home/box /workspace

# User-level installs land in the home: harness install jobs run
# `npm install -g`, native installers write ~/.local/bin. Set AFTER the global
# installs above (hnx + the Inspector stay image-owned) and APPENDED to PATH,
# so the image's own hnx always wins over a stray copy in the volume.
ENV NPM_CONFIG_PREFIX=/home/box/.npm-global
ENV PATH=$PATH:/home/box/.npm-global/bin:/home/box/.local/bin

USER box
WORKDIR /home/box

COPY --chmod=0755 entrypoint.sh /usr/local/bin/hnx-box

# Box mode: Inspector web UI (6274) and its MCP Apps sandbox (6275 — a second
# origin the Inspector requires). The entrypoint enables the inspector's
# bind-all flag: THIS container is the isolation it demands; publish both on
# 127.0.0.1 of the runner's machine. Machine mode publishes nothing.
EXPOSE 6274 6275

ENV HNX_PROFILE=default
# Disposable box: keep the inspector's secrets in memory (no OS keychain in
# the container; silences its PermissionDenied fallback warning).
ENV MCP_INSPECTOR_SECRET_STORE=memory

ENTRYPOINT ["/usr/bin/tini", "--", "hnx-box"]
CMD ["box"]
