#!/bin/sh
# hnx-box — entrypoint for the harness-nexus-client image.
#
#   docker run … sinrimin/harness-nexus-client              # box mode (default)
#   docker run … sinrimin/harness-nexus-client machine      # machine mode (#118)
#   docker run … sinrimin/harness-nexus-client hnx …        # CLI passthrough
#   docker run -it … sinrimin/harness-nexus-client bash     # shell
#
# Box mode with HNX_SERVER + HNX_TOKEN: verifies the token, lists the
# profile's aggregated tools headlessly, then starts the MCP Inspector web
# UI preconfigured for the same endpoint. Without the env: prints the
# getting-started steps and drops to a shell.
#
# Machine mode runs `hnx daemon` in the foreground: the container is a machine
# of the instance and its state lives in the /home/box volume (the state
# contract is in the Dockerfile header).

set -u

# ---- root phase — only when started as root (`--user 0`) --------------------
# Remap `box` to the host's uid/gid (a bind-mounted /workspace stays writable
# on hosts whose uid is not 1000), fix the home's ownership (a volume first
# written under another uid, or a fresh bind dir), then drop privileges and
# re-enter as `box`. The exec keeps this pid, so the daemon gets the same pid
# on every start. The default run is non-root and never gets here.
if [ "$(id -u)" = 0 ]; then
  if [ "${HNX_UID:-}" = 0 ] || [ "${HNX_GID:-}" = 0 ]; then
    echo "hnx-box: HNX_UID/HNX_GID 0 refused — the box user must not be root" >&2
    exit 64
  fi
  if [ -n "${HNX_GID:-}" ] && [ "$HNX_GID" != "$(id -g box)" ]; then
    groupmod -o -g "$HNX_GID" box || exit 1
  fi
  if [ -n "${HNX_UID:-}" ] && [ "$HNX_UID" != "$(id -u box)" ]; then
    usermod -o -u "$HNX_UID" box || exit 1
  fi
  if [ "$(stat -c %u:%g /home/box)" != "$(id -u box):$(id -g box)" ]; then
    echo "hnx-box: handing /home/box to uid $(id -u box):$(id -g box) (one time)"
    chown -R box:box /home/box
  fi
  export HOME=/home/box USER=box LOGNAME=box
  exec setpriv --reuid=box --regid=box --init-groups -- /usr/local/bin/hnx-box "$@"
fi

# ---- home seed ---------------------------------------------------------------
# An empty NAMED volume is seeded from the image's home on first mount; a
# bind-mounted home starts empty. Restore the shell skeleton without clobbering
# anything already there, plus the user-level install dirs PATH expects.
for f in /etc/skel/.[!.]*; do
  if [ -e "$f" ] && [ ! -e "$HOME/${f##*/}" ]; then cp -R "$f" "$HOME/"; fi
done
mkdir -p "$HOME/.npm-global/bin" "$HOME/.local/bin" 2>/dev/null || true

server="${HNX_SERVER:-}"
token="${HNX_TOKEN:-}"
profile="${HNX_PROFILE:-default}"

# ---- machine mode --------------------------------------------------------------
if [ "${1:-}" = machine ]; then
  echo "hnx-box machine — Harness Nexus machine container"
  if ! mountpoint -q "$HOME"; then
    echo "WARNING: $HOME is not a mounted volume — the enrollment, the adapters and" >&2
    echo "         every agent's skills, settings and sessions vanish with this" >&2
    echo "         container. Mount one: -v hnx-machine:$HOME" >&2
  fi
  if mountpoint -q /workspace; then
    echo "workspace: /workspace — set it as the machine's base workspace in the web UI"
  fi
  # A container start is a fresh pid namespace: every pid a previous instance
  # recorded under ~/.hnx died with it. Left in place, a stale daemon lock
  # whose pid now belongs to another process here (tini is pid 1) refuses the
  # daemon on every restart, and the adapter ledger could aim the boot sweep
  # at an unrelated process group. Nothing else runs yet, so both records are
  # void. (One container per home volume.)
  rm -f "$HOME/.hnx/daemon.lock" "$HOME"/.hnx/adapters/*.json

  if [ -f "$HOME/.hnx/config.json" ] && [ -z "${HNX_MACHINE_ID:-}" ]; then
    if [ -n "$token" ]; then
      echo "note: HNX_TOKEN is no longer needed — the identity lives in the volume"
    fi
    echo "identity found in the volume — starting the daemon"
    exec hnx daemon
  fi
  if [ -n "${HNX_MACHINE_ID:-}" ]; then
    if [ -z "$server" ] || [ -z "$token" ]; then
      echo "HNX_MACHINE_ID needs HNX_SERVER and HNX_TOKEN (the machine token from Machines → Enroll)" >&2
      exit 64
    fi
    echo "machine $HNX_MACHINE_ID — starting the daemon (the identity is saved to the volume)"
    exec hnx daemon --server "$server" --token "$token" --machine-id "$HNX_MACHINE_ID"
  fi
  if [ -n "$server" ] && [ -n "$token" ]; then
    name="${HNX_MACHINE_NAME:-$(hostname)}"
    echo "enrolling as \"$name\" — once; the identity stays in the volume"
    hnx enroll --server "$server" --token "$token" --name "$name" || exit 1
    exec hnx daemon
  fi
  cat >&2 <<'EOF'
No identity in the volume and no enrollment env. Either let the container
enroll itself once with a personal access token:
    -e HNX_SERVER=https://your-harness-nexus -e HNX_TOKEN=hnpat_… [-e HNX_MACHINE_NAME=…]
or pass the triple from the web UI (Machines → Enroll):
    -e HNX_SERVER=… -e HNX_TOKEN=<machine token> -e HNX_MACHINE_ID=…
and mount the state volume: -v hnx-machine:/home/box
EOF
  exit 64
fi

# The inspector refuses non-loopback binds unless told it is containerized.
# This image IS the isolated container it asks for — the published ports land
# on the RUNNER's own machine, exactly the deployment the flag is meant for.
# (Box mode and passthrough only: machine mode keeps HOST out of the env every
# agent and its dev servers inherit.)
export HOST=0.0.0.0
export DANGEROUSLY_BIND_ALL_INTERFACES=true
export MCP_AUTO_OPEN_ENABLED=false

# Any other explicit command (other than the default "box") runs as-is.
if [ "$#" -gt 0 ] && [ "$1" != "box" ]; then
  exec "$@"
fi

# ---- box mode ------------------------------------------------------------------
echo "hnx-box — Harness Nexus client environment"
echo

if [ -z "$server" ] || [ -z "$token" ]; then
  echo "HNX_SERVER / HNX_TOKEN are not set. To connect:"
  echo
  echo "  1. open the Harness Nexus web UI and register,"
  echo "  2. create a personal access token (hnpat_…),"
  echo "  3. rerun with:"
  echo "       docker run -it --rm -p 127.0.0.1:6274:6274 -p 127.0.0.1:6275:6275 \\"
  echo "         -e HNX_SERVER=https://your-harness-nexus \\"
  echo "         -e HNX_TOKEN=hnpat_… \\"
  echo "         sinrimin/harness-nexus-client"
  echo
  echo "To run this image as a machine instead, see 'machine' mode in the README."
  echo "Dropping to a shell meanwhile — hnx is on PATH."
  exec bash
fi

url="$server/mcp?profile=$profile"
echo "server:  $server"
echo "profile: $profile"
if curl -fsS -m 10 -H "Authorization: Bearer $token" "$server/api/auth/me" >/dev/null 2>&1; then
  echo "token:   OK"
else
  echo "token:   CHECK FAILED ($server/api/auth/me) — starting anyway"
fi
echo
echo "Aggregated tools at $url:"
# The URL must precede the options: --header is variadic and swallows any
# positional that follows it.
mcp-inspector --cli "$url" --method tools/list --transport http \
  --header "Authorization: Bearer $token" || true
echo
echo "Starting the MCP Inspector — open the URL it prints (host port 6274)."
exec mcp-inspector --web --transport http --server-url "$url" \
  --header "Authorization: Bearer $token"
