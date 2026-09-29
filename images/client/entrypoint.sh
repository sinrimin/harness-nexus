#!/bin/sh
# hnx-box — entrypoint for the harness-nexus-client image.
#
#   docker run … sinrimin/harness-nexus-client              # box mode (default)
#   docker run … sinrimin/harness-nexus-client hnx …        # CLI passthrough
#   docker run -it … sinrimin/harness-nexus-client bash     # shell
#
# Box mode with HNX_SERVER + HNX_TOKEN: verifies the token, lists the
# profile's aggregated tools headlessly, then starts the MCP Inspector web
# UI preconfigured for the same endpoint. Without the env: prints the
# getting-started steps and drops to a shell.

set -u

# The inspector refuses non-loopback binds unless told it is containerized.
# This image IS the isolated container it asks for — the published ports land
# on the RUNNER's own machine, exactly the deployment the flag is meant for.
export HOST=0.0.0.0
export DANGEROUSLY_BIND_ALL_INTERFACES=true
export MCP_AUTO_OPEN_ENABLED=false

server="${HNX_SERVER:-}"
token="${HNX_TOKEN:-}"
profile="${HNX_PROFILE:-default}"

# Any explicit command (other than the default "box") runs as-is.
if [ "$#" -gt 0 ] && [ "$1" != "box" ]; then
  exec "$@"
fi

echo "hnx-box — Harness Nexus client environment"
echo

if [ -z "$server" ] || [ -z "$token" ]; then
  echo "HNX_SERVER / HNX_TOKEN are not set. To connect:"
  echo
  echo "  1. open the Harness Nexus web UI and register,"
  echo "  2. create a personal access token (hnpat_…),"
  echo "  3. rerun with:"
  echo "       docker run -it --rm -p 6274:6274 -p 6275:6275 \\"
  echo "         -e HNX_SERVER=https://your-harness-nexus \\"
  echo "         -e HNX_TOKEN=hnpat_… \\"
  echo "         sinrimin/harness-nexus-client"
  echo
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
