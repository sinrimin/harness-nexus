# Harness Nexus client

A one-command client environment for any
[Harness Nexus](https://github.com/sinrimin/harness-nexus) server: the `hnx`
CLI and the official MCP Inspector in a disposable container — nothing gets
installed on your machine.

## Run

```bash
docker run -it --rm -p 6274:6274 -p 6275:6275 \
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
- `HNX_PROFILE` — the profile to consume (default: `default`).

Without `HNX_SERVER`/`HNX_TOKEN` the box prints getting-started steps and
drops to a shell. Any argument replaces the box flow entirely:
`… sinrimin/harness-nexus-client hnx …` or `… bash`.

## What's inside

Node.js 22, `@harness-nexus/cli`, `@modelcontextprotocol/inspector`. The
inspector's bind-all flag is enabled inside the container — the container is
the isolation it requires, and the published ports land on your own machine.
