# Harness Nexus client

A one-command client environment for any
[Harness Nexus](https://github.com/sinrimin/harness-nexus) server: the `hnx`
CLI and the official MCP Inspector in a disposable container — nothing gets
installed on your machine. The same image also runs as a **machine
container** (below): `hnx daemon` under tini, with the machine's state in a
volume.

## Run (client box)

```bash
docker run -it --rm -p 127.0.0.1:6274:6274 -p 127.0.0.1:6275:6275 \
  -e HNX_SERVER=https://your-harness-nexus \
  -e HNX_TOKEN=hnpat_… \
  sinrimin/harness-nexus-client
```

The box verifies the token, prints the profile's aggregated tool list, then
serves the MCP Inspector at `http://localhost:6274`, already pointed at the
server's `/mcp` outlet — nothing to configure in the UI.

- `HNX_SERVER` — base URL of the Harness Nexus server (its public https
  origin).
- `HNX_TOKEN` — personal access token (`hnpat_…`), created in the web UI
  (Tokens → New).
- `HNX_PROFILE` — the profile to consume (default: `default`; the value is
  the profile **id** shown in the web UI).

Publish the ports on `127.0.0.1`: the Inspector's auth token is CSRF
protection, not access control. Without `HNX_SERVER`/`HNX_TOKEN` the box
prints getting-started steps and drops to a shell. Any argument replaces the
box flow entirely: `… sinrimin/harness-nexus-client hnx …` or `… bash`.

## Run (machine container)

`… machine` runs `hnx daemon` as PID 1 under tini — the container is a
machine of the instance. State lives outside the container: the home as a
named volume (enrollment identity, pinned adapters, every agent's
skills/settings/credentials/session history, user-level installs), project
files bind-mounted at `/workspace` (set it as the machine's base workspace in
the web UI).

```bash
docker volume create hnx-mybox-home
docker run -d --name hnx-mybox --restart unless-stopped \
  -v hnx-mybox-home:/home/box \
  -v "$HOME/projects:/workspace" \
  -e HNX_SERVER=https://your-harness-nexus \
  -e HNX_TOKEN=hnpat_… \
  sinrimin/harness-nexus-client machine
```

First start only: `HNX_SERVER` + `HNX_TOKEN` (a personal access token) let
the container enroll itself — or pass the web UI's triple
(Machines → Enroll: `-e HNX_MACHINE_ID=…` with the machine token), optionally
`-e HNX_MACHINE_NAME=…` for the self-enroll path. The identity is saved to
the volume; later starts — and upgrades (pull + recreate with the same
volume) — need no env. Harness CLIs the server installs land in
`~/.npm-global` inside the volume. If the host uid is not 1000, start with
`--user 0 -e HNX_UID=$(id -u) -e HNX_GID=$(id -g)`: the entrypoint remaps
the user, hands the home over once and drops back to non-root. One container
per home volume. `HNX_PROFILE`/inspector env is ignored in machine mode.

## What's inside

Node.js 22, `@harness-nexus/cli`, `@modelcontextprotocol/inspector`, plus the
baseline coding-agent toolbox (git, ssh client, ps, python3) and tini as PID
1. The inspector's bind-all flag is enabled inside the container — the
container is the isolation it requires, and the published ports land on your
own machine. Image-owned tools (`hnx`, the Inspector) live under
`/usr/local`; anything installed at runtime (adapters, harness CLIs) lands in
the home, so it survives image upgrades when the home is a volume.
