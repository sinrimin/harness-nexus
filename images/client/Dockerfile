# Harness Nexus client box — a one-command client environment (#28).
#
# Bundles the `hnx` CLI and the official MCP Inspector, pointed at any Harness
# Nexus server via env (HNX_SERVER / HNX_TOKEN / HNX_PROFILE); the public demo
# is this image with HNX_SERVER=https://demo.harness-nexus.com.
#
# Build context is this directory ONLY — everything installs from npm, nothing
# from the workspace is needed. docker.yml pins CLI_VERSION to the release tag
# so the image and the npm release stay in lockstep.

FROM node:22-slim

ARG CLI_VERSION=latest

# CN mirrors for apt + npm, matching the server/web Dockerfiles: builds need
# no proxy from CN networks, and the mirrors are reachable world-wide.
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && npm config set registry https://registry.npmmirror.com/ \
  && npm install -g @harness-nexus/cli@${CLI_VERSION} @modelcontextprotocol/inspector \
  && npm config delete registry

# Non-root; disposable home — `hnx enroll` writes ~/.hnx/config.json at runtime.
RUN useradd --create-home --shell /bin/bash box
USER box
WORKDIR /home/box

COPY --chmod=0755 entrypoint.sh /usr/local/bin/hnx-box

# Inspector web UI (6274) and sandbox (6275). The entrypoint enables the
# inspector's bind-all flag: THIS container is the isolation it demands, and
# the published ports land on the runner's own machine.
EXPOSE 6274 6275

ENV HNX_PROFILE=default
# Disposable box: keep the inspector's secrets in memory (no OS keychain in
# the container; silences its PermissionDenied fallback warning).
ENV MCP_INSPECTOR_SECRET_STORE=memory

ENTRYPOINT ["hnx-box"]
CMD ["box"]
