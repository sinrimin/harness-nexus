import { z } from 'zod';
import {
  inventoryArtifactSchema,
  inventoryItemKindSchema,
  inventorySnapshotSchema,
  runtimeInfoSchema,
  runtimeTargetSchema,
} from './schemas/inventory.js';
import { agentTargetSchema } from './schemas/profile.js';

/**
 * Realtime protocol v1 (Phase 8) — Socket.IO over WSS.
 *
 * One bidirectional namespace per client role: `/ctl` (daemon, machine PAT)
 * and `/app` (browser, JWT/PAT). Event names are `domain:verb`; only
 * whitelisted handlers are registered server-side, and every payload is
 * validated with the schemas below (single source for server, daemon, and
 * web). See wiki design-phase-8-client.md ("Realtime protocol").
 */

/** Wire protocol version; carried in the machine:hello ack. Breaking changes bump namespaces (`/v2/ctl`), not this silently. */
export const REALTIME_PROTO_VERSION = 1;

// ---- handshake (Socket.IO `auth` object, verified in namespace middleware) ----

/** `/ctl` — the daemon presents its machine PAT and the machine it claims to be. */
export const ctlHandshakeAuthSchema = z.object({
  token: z.string().min(1),
  machineId: z.string().min(1),
});

/** `/app` — the browser presents its JWT or api PAT. */
export const appHandshakeAuthSchema = z.object({
  token: z.string().min(1),
});

// ---- /ctl events (C1) ----

/** daemon → server, ack'd. Reports daemon identity; server persists it as Machine metadata. */
export const machineHelloSchema = z.object({
  daemonVersion: z.string().min(1).max(64),
  os: z.string().max(64).optional(),
  arch: z.string().max(32).optional(),
  hostname: z.string().max(255).optional(),
  capabilities: z.array(z.string().min(1).max(64)).max(32).default([]),
});

/** server → daemon ack for `machine:hello`. */
export const machineHelloAckSchema = z.object({
  proto: z.number().int().min(1),
  machineId: z.string().min(1),
  /** #37 — the server build version, so an older daemon can warn locally. */
  serverVersion: z.string().min(1).max(64).optional(),
});

/** Ack error shape for any malformed event (`proto:invalid`). */
export const protoErrorAckSchema = z.object({ error: z.string().min(1) });

/**
 * #45 — server → daemon, fatal. A second live daemon socket for this machine
 * connected (bypassed/deleted lock): the newcomer is being refused, or — via
 * this event — told to stand down because it lost the connection race. Every
 * room broadcast reaches every socket, so two sockets mean prompts AND
 * dispatched jobs run twice; the daemon exits on this event.
 */
export const ctlDuplicateEventSchema = z.object({
  reason: z.literal('machine-already-connected'),
});

// ---- /app events (C1) ----

/** server → browser: a machine's live presence changed. `online` is socket presence — never faked. */
export const machineStatusEventSchema = z.object({
  machineId: z.string().min(1),
  online: z.boolean(),
  lastSeenAt: z.string().datetime().nullable(),
  daemonVersion: z.string().nullable().optional(),
});

// ---- job envelopes (C1 framing, C4 semantics) ----

export const jobTypeSchema = z.enum(['deploy', 'import', 'scan', 'harness']);
export const jobStatusSchema = z.enum([
  'queued',
  'dispatched',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

/** The `Job` wire shape shared by REST and `job:update` / `job:dispatch` events. */
export const jobViewSchema = z.object({
  id: z.string().min(1),
  machineId: z.string().min(1),
  ownerId: z.string().min(1),
  type: jobTypeSchema,
  status: jobStatusSchema,
  payload: z.unknown(),
  result: z.unknown().nullable().optional(),
  error: z.string().nullable().optional(),
  /** Delivery attempts (disconnect/ack-timeout recoveries increment it; ≥ max ⇒ failed). */
  attempts: z.number().int().min(0).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * The claude-code arm of a deploy payload (#6): presence routes the daemon to
 * the CC marketplace executor (`claude plugin marketplace add|update` +
 * install/update) instead of the 3.3 adapter pipeline. The daemon fills its
 * own machine PAT into the URL — no secret rides the payload or the job row.
 */
export const marketplaceDeployArmSchema = z.object({
  /** PUBLIC_BASE_URL origin (CC enforces https + non-loopback on archives). */
  baseUrl: z.string().min(1).max(512),
  /** `harness-nexus-<username>` — one marketplace per user (CC rejects name/URL remixing). */
  marketplaceName: z.string().min(1).max(128),
  /** The profile's name = the CC plugin name inside that marketplace. */
  pluginName: z.string().min(1).max(128),
});
export type MarketplaceDeployArm = z.infer<typeof marketplaceDeployArmSchema>;

/** `Job.payload` for `type: 'deploy'` (C4). */
export const deployJobPayloadSchema = z.object({
  profileId: z.string().min(1).max(64),
  /** Optional install-root override on the machine (maps to the planner's `outDir`). */
  directory: z.string().min(1).max(512).optional(),
  /** claude-code deploys carry the marketplace arm (#6); adapter deploys omit it. */
  marketplace: marketplaceDeployArmSchema.optional(),
});

/**
 * `Job.payload` for `type: 'harness'` (Phase 9 W2/W3) — install / upgrade /
 * pin the harness runtime itself, or apply its provider config. Omitting
 * `version` means the dist-tag default (claude-code `@stable`, others
 * `@latest`); `pin` exists precisely to pin, so it demands one. The secret
 * never rides the job: `apply-config` payloads name only the target — the
 * daemon fetches the resolved `{spec, secret}` bundle with its machine PAT at
 * execution time (requeue after a credential edit picks up the new value).
 */
export const harnessActionSchema = z.enum(['install', 'upgrade', 'pin', 'apply-config']);
export const harnessJobPayloadSchema = z
  .object({
    type: z.literal('harness'),
    action: harnessActionSchema,
    target: runtimeTargetSchema,
    /**
     * npm version spec (bare semver or dist-tag); omit = channel default.
     * Charset-restricted (#21): npm-package-arg also accepts URL/git specs,
     * which would make `npm install -g pkg@<url>` fetch an attacker-chosen
     * tarball and run its install scripts — only bare specs are allowed.
     */
    version: z
      .string()
      .regex(/^[\w.+-]+$/, 'bare semver/dist-tag only (no URLs or git specs)')
      .min(1)
      .max(64)
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'pin' && v.version === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pin requires a version',
      });
    }
    if (v.action === 'apply-config' && v.version !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'apply-config takes no version',
      });
    }
  });

/** The REST body of `POST /api/machines/:id/jobs` — type-discriminated (W2);
 * a body without `type` is a deploy (the pre-W2 shape every SDK caller sends). */
export const createMachineJobSchema = z.preprocess(
  (v) => (typeof v === 'object' && v !== null && !('type' in v) ? { type: 'deploy', ...v } : v),
  z.union([deployJobPayloadSchema.extend({ type: z.literal('deploy') }), harnessJobPayloadSchema]),
);

/** What a daemon reports in `job:result.data` for a successful harness job (W2/W3). */
export const harnessResultDataSchema = z.object({
  target: runtimeTargetSchema,
  action: harnessActionSchema,
  version: z.string().max(64).optional(),
  binPath: z.string().max(512).optional(),
  installMethod: z.enum(['npm', 'native', 'brew', 'unknown']).optional(),
  /** apply-config only: the native config files written (display paths). */
  files: z.array(z.string().max(512)).max(8).optional(),
  /** Non-fatal follow-up note (e.g. settings.json left untouched). */
  warning: z.string().max(512).optional(),
});
export type HarnessResultData = z.infer<typeof harnessResultDataSchema>;

/** server → browser (/app): a job transitioned. */
export const jobUpdateEventSchema = z.object({ job: jobViewSchema });

/** What a daemon reports in `job:result.data` for a successful deploy (C4). */
export const deployResultDataSchema = z.object({
  name: z.string().min(1).max(128),
  /** Adapter deploys: the install root. Marketplace deploys: `~/.claude/plugins`. */
  directory: z.string().min(1).max(512),
  target: z.string().min(1).max(32),
  profileId: z.string().min(1).max(64),
  profileVersion: z.string().max(64).optional(),
  /** #6: which deploy path ran — absent = the 3.3 adapter pipeline. */
  method: z.enum(['adapter', 'marketplace']).optional(),
  /** #6 marketplace deploys: the version CC reports after install/update. */
  installedVersion: z.string().max(64).optional(),
});
export type DeployResultData = z.infer<typeof deployResultDataSchema>;

/** server → daemon: execute this job (ack = accepted, not completed). */
export const jobDispatchEventSchema = z.object({ job: jobViewSchema });

/** daemon → server: non-terminal progress. */
export const jobProgressEventSchema = z.object({
  jobId: z.string().min(1),
  phase: z.string().min(1).max(64),
  message: z.string().max(512).optional(),
  percent: z.number().min(0).max(100).optional(),
});

/** daemon → server: terminal result. */
export const jobResultEventSchema = z.object({
  jobId: z.string().min(1),
  ok: z.boolean(),
  error: z.string().max(1024).optional(),
  data: z.unknown().optional(),
});

// ---- /ctl inventory events (C3) ----

/** server → daemon: scan these targets and reply one `inventory:report` per target. */
export const inventoryScanRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  targets: z.array(agentTargetSchema).min(1).max(8),
});

/**
 * daemon → server: a fresh snapshot. `requestId` present when answering a scan
 * request. `runtimes` (Phase 9 W1) carries the full runtime-probe result of the
 * scan cycle — the daemon folds it into every report (one probe feeds all
 * targets' rows). Absent on daemon builds without the `runtime` capability.
 */
export const inventoryReportEventSchema = z.object({
  requestId: z.string().min(1).max(64).optional(),
  runtimes: z.array(runtimeInfoSchema).max(8).optional(),
  snapshot: inventorySnapshotSchema,
});

/** server → daemon: upload bodies for these items (paths are re-derived by a fresh scan — never trusted from the server). */
export const inventoryCollectRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  target: agentTargetSchema,
  items: z
    .array(z.object({ kind: inventoryItemKindSchema, name: z.string().min(1).max(128) }))
    .min(1)
    .max(200),
});

/** daemon → server: collected bodies. MCP env/header VALUES are already `${cred:<KEY>}` placeholders. */
export const inventoryPayloadEventSchema = z.object({
  requestId: z.string().min(1).max(64),
  items: z
    .array(
      z.object({
        kind: inventoryItemKindSchema,
        name: z.string().min(1).max(128),
        ok: z.boolean(),
        error: z.string().max(256).optional(),
        artifact: inventoryArtifactSchema.optional(),
      }),
    )
    .min(1)
    .max(200),
});

// ---- /ctl runtime config view events (Phase 9 W4) ----
//
// The redacted effective-config read-back: the server asks the daemon for a
// target's config files, the daemon MASKS secret-ish values (key-name-aware
// JSON walk + line masking for TOML/YAML; `.env` values are masked wholesale
// — the file exists to hold secrets) and replies. `path` values are display
// paths (`~/.codex/config.toml`) — the daemon's real home never leaks.

/** server → daemon: read + redact this target's effective config. */
export const runtimeConfigGetRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  target: runtimeTargetSchema,
});

/** daemon → server: the redacted view. `error` arm settles the waiter honestly. */
export const runtimeConfigViewEventSchema = z.object({
  requestId: z.string().min(1).max(64),
  target: runtimeTargetSchema,
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(512),
        content: z.string().max(131072),
      }),
    )
    .max(8)
    .optional(),
  /** What was hidden — `"<display-path>:<key>"` entries; empty iff nothing matched. */
  redacted: z.array(z.string().max(128)).max(64).default([]),
  error: z.string().max(512).optional(),
});
export type RuntimeConfigGetRequest = z.infer<typeof runtimeConfigGetRequestSchema>;
export type RuntimeConfigViewEvent = z.infer<typeof runtimeConfigViewEventSchema>;

// ---- /app events (C3) ----

/** server → browser: a machine's latest snapshot for one target changed. */
export const inventoryUpdatedEventSchema = z.object({
  machineId: z.string().min(1),
  target: agentTargetSchema,
  reportedAt: z.string().datetime(),
});

// ---- chat events / ACP dialect (C5) ----
//
// The browser speaks platform-semantic chat events; the daemon adapts them to
// each agent's protocol (ACP over stdio today — the adapter matrix lives in
// wiki research-phase-8-c5-acp-web-demo.md). These schemas are the SINGLE
// source for server, daemon, and web: every handler on either side validates
// with them (whitelisted-handler isolation rule).

export const acpToolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

export const acpToolStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed']);

export const acpLocationSchema = z.object({
  path: z.string().min(1).max(1024),
  line: z.number().int().min(0).optional(),
  lineEnd: z.number().int().min(0).optional(),
});

/**
 * Bounded view of an ACP ToolCallContent item — the structured arm
 * (`diff` for Edit/Write, `content` for Read-style text, `terminal`) the
 * rich tool cards (9 W6) prefer over raw output text.
 */
export const acpToolContentItemSchema = z.object({
  type: z.enum(['content', 'diff', 'terminal']),
  content: z
    .object({ type: z.string().max(64), text: z.string().max(100000).optional() })
    .optional(),
  path: z.string().max(1024).optional(),
  oldText: z.string().max(100000).nullable().optional(),
  newText: z.string().max(100000).optional(),
  terminalId: z.string().max(128).optional(),
});

/**
 * Bounded view of an ACP ToolCallUpdate — enough for tool rows, permission
 * cards, and (9 W6) the rich per-tool rendering: registry key (`toolName`,
 * from the update itself or `_meta.claudeCode.toolName`), raw arguments,
 * structured content, and the raw output text.
 */
export const acpToolCallViewSchema = z.object({
  toolCallId: z.string().min(1).max(128),
  title: z.string().max(512).optional(),
  toolName: z.string().min(1).max(128).optional(),
  kind: acpToolKindSchema.optional(),
  status: acpToolStatusSchema.optional(),
  locations: z.array(acpLocationSchema).max(16).optional(),
  /** Raw tool arguments (the daemon drops oversized Write-style payloads). */
  rawInput: z.record(z.string().max(128), z.unknown()).optional(),
  content: z.array(acpToolContentItemSchema).max(16).optional(),
  /** `rawOutput` text, capped. */
  output: z.string().max(100000).optional(),
});

/** ACP permission option — `optionId` is passed through VERBATIM in both directions. */
export const acpPermissionOptionSchema = z.object({
  optionId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});

/**
 * 9 W14.1 — a bounded rendering hint for ONE ACP elicitation form field,
 * extracted daemon-side from the `requestedSchema.properties` entry (never
 * the raw JSON schema on the wire). `type` is OUR hint: `enum`/`multi` come
 * from `oneOf`/`enum` consts, the rest from the property's declared type.
 */
export const elicitationFieldSchema = z.object({
  name: z.string().min(1).max(128),
  type: z.enum(['text', 'number', 'integer', 'boolean', 'enum', 'multi']),
  title: z.string().max(256).optional(),
  description: z.string().max(1024).optional(),
  placeholder: z.string().max(256).optional(),
  options: z
    .array(
      z.object({
        value: z.string().min(1).max(1024),
        label: z.string().max(256).optional(),
        description: z.string().max(1024).optional(),
      }),
    )
    .max(32)
    .optional(),
  required: z.boolean().optional(),
});

/**
 * One MIME an attached image may carry (9 W9 B). This is exactly the raster
 * vocabulary EVERY shipped adapter admits — dsh validates against the same
 * list server-side and rejects everything else with invalid_params.
 */
export const promptImageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Per-image base64 cap; with the ≤4-image / ≤6MB-per-turn send refine this
 * stays comfortably under the 8MB socket buffer including the envelope. */
export const PROMPT_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
export const PROMPT_IMAGE_MAX_COUNT = 4;
export const PROMPT_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;

/** Prompt content blocks the browser may send (text, file refs, images). */
export const promptBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(32000) }),
  z.object({
    type: z.literal('resource_link'),
    name: z.string().min(1).max(256),
    uri: z.string().min(1).max(2048),
  }),
  z.object({
    type: z.literal('image'),
    data: z.string().min(1).max(PROMPT_IMAGE_MAX_BYTES),
    mimeType: promptImageMimeSchema,
  }),
]);

/** Send-path blocks with the image budget refine (history batches do NOT
 * re-check totals — the daemon constructed them under the same caps). */
export const promptBlocksBudgetedSchema = z
  .array(promptBlockSchema)
  .min(1)
  .max(16)
  .refine((blocks) => blocks.filter((b) => b.type === 'image').length <= PROMPT_IMAGE_MAX_COUNT, {
    message: `at most ${PROMPT_IMAGE_MAX_COUNT} images per turn`,
  })
  .refine(
    (blocks) =>
      blocks.reduce((sum, b) => sum + (b.type === 'image' ? b.data.length : 0), 0) <=
      PROMPT_TOTAL_IMAGE_BYTES,
    { message: 'image payload exceeds the per-turn budget' },
  );

// ---- 9 W9 A: ACP session modes & configuration ----
//
// Mirrors the standard ACP surface (agentclientprotocol.com/protocol/
// session-modes) every shipped adapter implements: `modes` + `configOptions`
// on session/new|load|resume responses, `session/set_mode` /
// `session/set_config_option` requests, and the `current_mode_update` /
// `config_option_update` pushes. Option VALUES are opaque adapter keys
// (dsh's model value is JSON [provider, model]) — compare by equality only.

export const sessionModeSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
});

export const sessionModeStateSchema = z.object({
  currentModeId: z.string().min(1).max(128),
  availableModes: z.array(sessionModeSchema).min(1).max(32),
});

export const sessionConfigValueSchema = z.object({
  value: z.string().max(2048),
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  /** dsh groups model options by provider — display grouping only. */
  group: z.string().min(1).max(256).optional(),
});

export const sessionConfigOptionSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  /** Semantic category ('mode' | 'model' | 'thought_level' | …) — UX only. */
  category: z.string().min(1).max(64).optional(),
  currentValue: z.string().max(2048).optional(),
  options: z.array(sessionConfigValueSchema).max(256).optional(),
});

// ---- 9 W14: ACP plan (todo) snapshots ----
//
// `session/update {sessionUpdate:'plan', entries}` is a FULL REPLACE
// snapshot — ACP's own contract: "the agent must send a complete list of all
// entries with their current status". claude-agent-acp surfaces TodoWrite
// AND TaskCreate/TaskUpdate/TaskList exclusively this way (the tool calls
// are suppressed), codex-acp maps its update_plan tool to it; the daemon
// clamps (≤128 entries, content ≤512) before re-emitting on our wire.

export const planEntryStatusSchema = z.enum(['pending', 'in_progress', 'completed']);

export const planEntrySchema = z.object({
  content: z.string().min(1).max(512),
  status: planEntryStatusSchema,
  priority: z.enum(['high', 'medium', 'low']).optional(),
});

// ---- 9 W15: ACP available-commands catalogs ----
//
// `session/update {sessionUpdate:'available_commands_update',
// availableCommands}` is the agent's slash-command catalog, pushed after
// session/new|load|resume by claude-agent-acp (custom + MCP commands — the
// latter renamed `mcp:<name>`), codex-acp (review family + init/compact/
// logout) and opencode (its Command.Info list — platform-deployed custom
// commands surface here). dsh/hermes never push one. Invocation needs no
// protocol: an ordinary prompt whose text is `/name args`.

export const availableCommandViewSchema = z.object({
  /** VERBATIM adapter name (may carry the `mcp:` prefix) — the web adds the `/`. */
  name: z.string().min(1).max(128),
  description: z.string().max(512),
  /** From the command's unstructured `input.hint` (args placeholder). */
  hint: z.string().max(256).optional(),
});

/**
 * The `session_config` stream event — PATCH semantics: `availableModes` /
 * `configOptions` replace when present; a lone `currentModeId` patches the
 * current mode. The daemon emits full merged snapshots; the load-replay
 * capture path emits adapter pushes verbatim (it has no state to merge).
 */
export const sessionConfigPatchSchema = z.object({
  modes: z
    .object({
      currentModeId: z.string().max(128).optional(),
      availableModes: z.array(sessionModeSchema).min(1).max(32).optional(),
    })
    .optional(),
  configOptions: z.array(sessionConfigOptionSchema).max(64).optional(),
});

/**
 * The semantic chat stream (`chat:event` → `{ sessionId, event }`). Produced by
 * the daemon (mapped from ACP `session/update` etc.) plus `permission_resolved`
 * which the SERVER emits so every viewer's permission card settles. `raw` is
 * the escape hatch for unmapped protocol frames.
 */
export const chatStreamEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message_delta'), delta: z.string().min(0).max(100000) }),
  z.object({ kind: z.literal('thought_delta'), delta: z.string().min(0).max(100000) }),
  z.object({ kind: z.literal('tool_call'), call: acpToolCallViewSchema }),
  z.object({
    kind: z.literal('usage'),
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    /**
     * #39 — prompt-cache accounting, normalized from the per-target dialects
     * (Anthropic cache_creation/cache_read, deepseek prompt_cache_hit, …) by
     * the daemon. Optional because not every target reports them: a consumer
     * must treat absence as "unknown", never zero.
     */
    cacheReadTokens: z.number().int().min(0).optional(),
    cacheWriteTokens: z.number().int().min(0).optional(),
    /**
     * #44 — session-CUMULATIVE spend from `usage_update.cost.amount` (the
     * ACP session-usage RFD defines cost as cumulative session state). The
     * daemon converts to increments before accounting; absent = unknown.
     */
    costUsd: z.number().min(0).optional(),
    /**
     * dsh's ACP adapter reports CONTEXT OCCUPANCY instead of per-turn token
     * counts (`used` / `size` on its usage_update) — surfaced verbatim for
     * the turn tail's "ctx 8.5k/262k" readout.
     */
    contextUsed: z.number().int().min(0).optional(),
    contextSize: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal('permission_request'),
    requestId: z.string().min(1).max(128),
    toolCall: acpToolCallViewSchema,
    options: z.array(acpPermissionOptionSchema).min(1).max(8),
  }),
  z.object({
    kind: z.literal('permission_resolved'),
    requestId: z.string().min(1).max(128),
    outcome: z.enum(['selected', 'cancelled', 'timeout']),
    optionId: z.string().min(1).max(128).optional(),
  }),
  // 9 W14.1 — the agent asked the user a structured question (ACP
  // `elicitation/create`, form mode; claude's AskUserQuestion and
  // MCP-server elicitations both arrive here). `fields` may be EMPTY: the
  // schema was not representable, so the card offers decline/cancel only.
  z.object({
    kind: z.literal('elicitation_request'),
    requestId: z.string().min(1).max(128),
    message: z.string().max(2048),
    fields: z.array(elicitationFieldSchema).max(16),
    toolCallId: z.string().min(1).max(256).optional(),
  }),
  z.object({
    kind: z.literal('elicitation_resolved'),
    requestId: z.string().min(1).max(128),
    outcome: z.enum(['accepted', 'declined', 'cancelled', 'timeout']),
  }),
  z.object({
    kind: z.literal('turn_result'),
    stopReason: z.enum(['end_turn', 'cancelled', 'max_tokens', 'refusal']),
    /**
     * #44 — per-turn token usage, read off the agent's `session/prompt`
     * RESPONSE (the carrier the ACP end-turn-token-usage RFD proposes for
     * v1). Optional: adapters whose response carries no usage report through
     * `usage` events instead (dsh/pi), or not at all (codex on the wire
     * today). Cumulative-vs-per-turn is a per-adaptor dialect — consumers
     * must not assume either without knowing the source.
     */
    usage: z
      .object({
        inputTokens: z.number().int().min(0).optional(),
        outputTokens: z.number().int().min(0).optional(),
        cacheReadTokens: z.number().int().min(0).optional(),
        cacheWriteTokens: z.number().int().min(0).optional(),
        thoughtTokens: z.number().int().min(0).optional(),
        totalTokens: z.number().int().min(0).optional(),
      })
      .optional(),
  }),
  z.object({ kind: z.literal('session_status'), state: z.enum(['active', 'idle']) }),
  // #10 — the live Sender's send queue (SERVER-owned, depth 1). Emitted by
  // the SERVER — never the daemon — whenever the slot changes: enqueue,
  // flush, cancel, turn cancel. `prompt: null` = empty slot; `flushed`
  // distinguishes a clear-because-it-RUNS (the viewer folds the parked
  // blocks into a user row) from a clear-because-cancelled. A channel
  // (re)join replays the current state so the browser restores the chip.
  z.object({
    kind: z.literal('queue_state'),
    prompt: z.array(promptBlockSchema).min(1).max(16).nullable(),
    flushed: z.boolean(),
  }),
  // #11 — the prompt echo. The daemon's live stream never carries the user's
  // own message (ACP session/update is agent-side only), so without this the
  // user row existed ONLY on the sending tab's optimistic dispatch. The
  // SERVER emits it to the room on both send paths (direct + queue flush) —
  // the single source of truth; no adapter can double-render it because no
  // live user-item kind exists.
  z.object({
    kind: z.literal('user_message'),
    blocks: z.array(promptBlockSchema).min(1).max(16),
  }),
  // 9 W9 A — the session's mode/config snapshot (patch semantics above).
  z.object({ kind: z.literal('session_config') }).merge(sessionConfigPatchSchema),
  // 9 W14 — the agent's todo/task plan (full-replace snapshot; empty = cleared).
  z.object({ kind: z.literal('plan'), entries: z.array(planEntrySchema).max(128) }),
  // 9 W15 — the agent's slash-command catalog (full replace; empty = none).
  z.object({
    kind: z.literal('commands'),
    commands: z.array(availableCommandViewSchema).max(64),
  }),
  z.object({ kind: z.literal('raw'), method: z.string().min(1).max(64), params: z.unknown() }),
]);

/** `chat:event` envelope — daemon→server and (relayed) server→browser share it. */
export const chatStreamEventEnvelopeSchema = z.object({
  sessionId: z.string().min(1).max(64),
  event: chatStreamEventSchema,
});

/** browser → server: create a channel (no `sessionId`) or idempotently re-join an open one. */
export const chatSessionOpenRequestSchema = z.object({
  agentInstanceId: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(64).optional(),
  /**
   * Phase 9 W6 — the project working directory for the new session: a
   * subdirectory of the machine's baseWorkspace (validated server-side;
   * absent = the legacy default, the agent's install directory).
   */
  directory: z.string().min(1).max(1024).optional(),
  /**
   * Phase 9 W7 — resume the agent's OWN native session instead of creating
   * one. The values come from the daemon's `sessions:list` (ground truth on
   * the machine), so the `cwd` passes through verbatim — no baseWorkspace
   * containment (dsh enforces its own match).
   */
  resume: z
    .object({
      sessionId: z.string().min(1).max(128),
      cwd: z.string().min(1).max(1024),
    })
    .optional(),
});

/** server → daemon: spawn the agent subprocess for this channel. `cwd` defaults to the agent home. */
export const chatSessionStartEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  agentInstanceId: z.string().min(1).max(64),
  target: agentTargetSchema,
  cwd: z.string().min(1).max(1024),
  /** 9 W7 — present when this channel resumes a native session (`session/load` / `session/resume`). */
  resume: chatSessionOpenRequestSchema.shape.resume,
  /**
   * 9 W13 — the machine's configured model set for this target,
   * `unique([spec.model, ...spec.models])` from the stored RuntimeConfig.
   * Source for the daemon-side model-option rewrite (codex bare ids,
   * opencode `${OPENCODE_PROVIDER_ID}/<id>` values). Absent = no stored
   * config (or a pre-W13 server) → the daemon leaves adapter options alone.
   * Optional + stripped by old daemons' non-strict parse, so purely additive.
   */
  modelOptions: z.array(z.string().min(1).max(128)).max(32).optional(),
  /**
   * Issue #3 — the target's pre-warm switch is ON at open time. The daemon
   * re-arms one fresh prewarmed adapter AFTER this channel took one (or
   * spawned fresh), so the next open is warm too. Absent = switch off (or a
   * pre-#3 server) → no re-arm. Optional + stripped by old daemons' non-strict
   * parse, so purely additive.
   */
  prewarm: z.boolean().optional(),
});

// ---- adapter pre-warm (Issue #3) ----

/** Targets the pre-warm pool serves (pi = in-daemon façade, nothing to boot). */
export const PREWARM_ADAPTER_TARGETS = ['claude-code', 'codex', 'deepseek', 'opencode'] as const;

export type PrewarmAdapterTarget = (typeof PREWARM_ADAPTER_TARGETS)[number];

/** browser → server: boot the agent's adapter ahead of a likely open (best-effort). */
export const chatAdapterPrewarmRequestSchema = z.object({
  agentInstanceId: z.string().min(1).max(64),
});

/** server → daemon: keep ONE prewarmed adapter for this target (dedupe inside the pool). */
export const chatAdapterPrewarmEventSchema = z.object({
  target: agentTargetSchema,
});

/**
 * 9 W9 B — what the adapter's initialize result advertised about prompt
 * content (`agentCapabilities.promptCapabilities`). `image` gates the
 * composer's attach affordance (dsh derives it per model route, so it can
 * legitimately be false on a live channel).
 */
export const promptCapabilitiesSchema = z.object({
  image: z.boolean(),
  audio: z.boolean().optional(),
  embeddedContext: z.boolean().optional(),
});

/** daemon → server: subprocess + ACP handshake done (`error` ⇒ spawn/initialize failed). */
export const chatSessionReadyEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  agentName: z.string().max(128).optional(),
  agentVersion: z.string().max(64).optional(),
  /** 9 W7 — the agent's OWN session id behind this channel (row highlight + resume bookkeeping). */
  nativeSessionId: z.string().min(1).max(128).optional(),
  /** 9 W9 B — prompt content capabilities from the initialize handshake. */
  promptCapabilities: promptCapabilitiesSchema.optional(),
  error: z.string().max(512).optional(),
});

/** server → daemon: a viewer (re)joined a live channel — re-push its history (9 W7). */
export const chatSessionResyncEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
});

/**
 * One item of a channel's history (9 W7): the user's own prompt blocks, or an
 * ordinary stream event. Expressing history as events (not a parallel row
 * model) keeps live and history on ONE fold path in the browser.
 */
export const historyItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), blocks: z.array(promptBlockSchema).min(1).max(16) }),
  z.object({ type: z.literal('event'), event: chatStreamEventSchema }),
]);

/** daemon → server (relayed to the channel room): the transcript batch for a (re)joined channel. */
export const chatHistoryEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  items: z.array(historyItemSchema).min(1).max(2000),
});

/** browser → server: send a turn prompt. */
export const chatMessageSendRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  content: z.union([z.string().min(1).max(32000), promptBlocksBudgetedSchema]),
});

/** server → daemon: the normalized prompt blocks for `session/prompt`. */
export const chatPromptEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  prompt: promptBlocksBudgetedSchema,
});

/**
 * 9 W9 A — switch the live session's permission mode / one config option.
 * `chat:config.set` in both directions (browser → server → daemon); the
 * daemon forwards `session/set_mode` / `session/set_config_option` and the
 * new state returns as `session_config` stream events. `value` may be ''
 * (dsh's provider-default reasoning effort).
 */
export const chatConfigSetRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    sessionId: z.string().min(1).max(64),
    kind: z.literal('mode'),
    modeId: z.string().min(1).max(128),
  }),
  z.object({
    sessionId: z.string().min(1).max(64),
    kind: z.literal('option'),
    configId: z.string().min(1).max(128),
    value: z.string().max(2048),
  }),
]);

/** server → daemon: same shape, forwarded verbatim over /ctl. */
export const chatConfigSetEventSchema = chatConfigSetRequestSchema;

/** browser → server and server → daemon: cancel the running turn (idempotent). */
export const chatTurnCancelEventSchema = z.object({ sessionId: z.string().min(1).max(64) });

/** browser → server: drop the parked send-queue entry (#10; edit = cancel + re-draft). */
export const chatQueueCancelRequestSchema = z.object({ sessionId: z.string().min(1).max(64) });

/** browser → server: answer a permission request; absent `optionId` = cancelled. */
export const chatPermissionRespondRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  requestId: z.string().min(1).max(128),
  optionId: z.string().min(1).max(128).optional(),
});

/** server → daemon: forwarded permission decision (or timeout/user cancel). */
export const chatPermissionRespondEventSchema = chatPermissionRespondRequestSchema;

/**
 * 9 W14.1 — browser → server: answer an elicitation. `accept` carries the
 * form values keyed by field name (forwarded VERBATIM as the ACP `content`);
 * `values` absent/empty on accept = an empty form submit.
 */
export const chatElicitationRespondRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  requestId: z.string().min(1).max(128),
  action: z.enum(['accept', 'decline', 'cancel']),
  values: z
    .record(
      z.string().min(1).max(128),
      z.union([
        z.string().max(10000),
        z.number(),
        z.boolean(),
        z.array(z.string().max(10000)).max(32),
      ]),
    )
    .refine((r) => Object.keys(r).length <= 16, { message: 'too many values' })
    .optional(),
});

/** server → daemon: forwarded decision (or timeout/user cancel). */
export const chatElicitationRespondEventSchema = chatElicitationRespondRequestSchema;

/** browser → server: close the channel. */
export const chatSessionCloseRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  reason: z.string().max(128).optional(),
});

/** server → daemon: kill the subprocess for this channel. */
export const chatSessionCloseEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  reason: z.string().max(128).optional(),
});

/** daemon → server: the channel ended daemon-side (agent process exited / fatal). */
export const chatSessionClosedEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  reason: z.string().max(256),
});

/**
 * server → daemon on EVERY /ctl (re)connect (9 W11 E): the server's live
 * channel rows for the machine. The daemon tears down any session it holds
 * that is NOT listed (its row was reaped while the daemon grace-kept it, or
 * the server restarted) and acks with the ids it still holds — registered
 * sessions plus establishments in flight for LISTED ids. The server then
 * closes rows the daemon does not hold (ghosts of a daemon hard-death).
 * Ownership stays server-side (Principle 1): the daemon never re-adopts
 * rows, it only drops what the server disowned.
 */
export const chatReconcileEventSchema = z.object({
  sessionIds: z.array(z.string().min(1).max(64)).max(64),
});

/** daemon → server: the `chat:reconcile` ack. */
export const chatReconcileAckSchema = z.object({
  held: z.array(z.string().min(1).max(64)).max(64),
});

/**
 * One adapter process the RUNNING daemon owns (9 W11 C — the adapter
 * report). Straight from the daemon's live sessions map, NOT the ledger:
 * the report is present-tense truth ("what is running"), while the ledger
 * is crash accounting ("what must be swept if I die").
 */
export const adapterProcessViewSchema = z.object({
  /** The platform channel id (= the ledger file's key). */
  wireSessionId: z.string().min(1).max(64),
  target: z.string().min(1).max(32),
  /** The process-group id (0 = unknown; always real for a live session). */
  pgid: z.number().int().min(0),
  nativeSessionId: z.string().min(1).max(128).optional(),
  startedAt: z.number().int().positive(),
  /** The spawn command's executable (e.g. `npx`) — no args, no secrets. */
  command: z.string().min(1).max(256),
});

/** server → daemon: report the adapter processes you own (9 W11 C). */
export const adaptersReportRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
});

/** daemon → server: the report (`error` arm settles the waiter honestly). */
export const adaptersReportResultEventSchema = z.object({
  requestId: z.string().min(1).max(64),
  adapters: z.array(adapterProcessViewSchema).max(64).optional(),
  error: z.string().max(512).optional(),
});

/**
 * One of the agent's OWN persisted sessions (9 W7) — `session/list` from the
 * target's ACP adapter (claude-code/codex) or dsh's native store, surfaced
 * through `GET /api/agent-instances/:id/sessions`. The platform persists
 * NOTHING session-shaped; this is a live read.
 */
export const nativeSessionViewSchema = z.object({
  sessionId: z.string().min(1).max(128),
  cwd: z.string().min(1).max(1024),
  title: z.string().max(256).nullable().optional(),
  // `offset: true` — codex-acp (Rust chrono) serializes RFC3339 with a
  // `+00:00` offset, not the `Z` suffix; strict datetime REJECTED the whole
  // listing payload and the route degraded to a silent 30s timeout
  // ("Daemon did not answer the listing in time", rig-found 2026-09-14).
  updatedAt: z.string().datetime({ offset: true }).nullable().optional(),
  /**
   * 9 W7 — the model route the session PINNED at creation (dsh transcripts
   * record it; adapters don't report it). Display + staleness input.
   */
  model: z.string().max(128).nullable().optional(),
  /**
   * Present when the daemon KNOWS this session cannot be resumed (e.g. dsh
   * validates the pinned route against the live provider catalog — a config
   * change orphans old sessions). `'model-missing'` today.
   */
  staleReason: z.string().max(64).optional(),
  /**
   * Server-computed at REST-listing time: a live chat channel is currently
   * attached to this native session. The daemon never sets it — it cannot
   * know the server's channel table.
   */
  open: z.boolean().optional(),
  /**
   * With `open`: the CHANNEL id of the live channel on this native session.
   * `chat:session.open {sessionId: openChannelId}` rejoins it (vs. `resume`,
   * which would spawn a second channel for the same agent session).
   */
  openChannelId: z.string().min(1).max(128).optional(),
});

/** server → daemon: list the target's native sessions. */
export const sessionsListRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  target: agentTargetSchema,
  /**
   * 9 W11 D — bypass the daemon's listing TTL cache (the rail's manual
   * refresh button). Optional so older daemons strip it harmlessly.
   */
  refresh: z.boolean().optional(),
});

/** daemon → server: the listing (`error` arm settles the waiter honestly). */
export const sessionsListResultEventSchema = z.object({
  requestId: z.string().min(1).max(64),
  sessions: z.array(nativeSessionViewSchema).max(200).optional(),
  /** False when this target has no native session surface at all (hermes/zcode). */
  supported: z.boolean().optional(),
  error: z.string().max(512).optional(),
});

/** server → browser lifecycle pushes (typed for the web client; server-constructed). */
export const chatSessionReadyPushSchema = z.object({
  sessionId: z.string().min(1),
  agentName: z.string().max(128).optional(),
  agentVersion: z.string().max(64).optional(),
  nativeSessionId: z.string().max(128).optional(),
});
export const chatSessionFailedPushSchema = z.object({
  sessionId: z.string().min(1),
  error: z.string().min(1).max(512),
});
export const chatSessionClosedPushSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.string().min(1).max(256),
});

/**
 * 9 W11 B — one live channel in the per-user `chat:channels` SNAPSHOT push.
 * The snapshot is the tab bar's source of truth: it fires on every channel
 * table change (open / ready / closed / busy flip / deferred) and once per
 * `/app` connect, so the browser never polls for channel state.
 */
export const chatChannelViewSchema = z.object({
  /** The CHANNEL (wire) id — `chat:session.open {sessionId}` rejoins it. */
  sessionId: z.string().min(1).max(64),
  agentInstanceId: z.string().min(1).max(64),
  machineId: z.string().min(1).max(64),
  /** Agent target (`claude-code` / `codex` / `deepseek` / …) — the tab badge. */
  target: z.string().min(1).max(32),
  phase: z.enum(['starting', 'ready']),
  /** A turn is generating on this channel right now. */
  busy: z.boolean(),
  /** Viewers left mid-turn — the channel closes itself when the turn ends. */
  deferred: z.boolean(),
  nativeSessionId: z.string().min(1).max(128).optional(),
  /** Epoch ms — the eviction order (oldest first). */
  openedAt: z.number().int().positive(),
  /**
   * 9 W11 D6 — epoch ms of the last turn's END (open time until the first
   * turn ends). The tab's idle-age label (past 30 minutes) and the optional
   * `CHAT_IDLE_TTL_MS` sweep both measure from here.
   */
  lastActiveAt: z.number().int().positive(),
});

/** server → browser (`user:<id>` room): the user's FULL live-channel snapshot. */
export const chatChannelsPushSchema = z.object({
  channels: z.array(chatChannelViewSchema).max(64),
});

/**
 * browser → server: close every live channel of the CALLER (9 W11 B — the
 * tab bar's 一键清理). Idle channels close immediately; busy ones flip to
 * deferred and close when the current turn ends.
 */
export const chatChannelsCloseAllRequestSchema = z
  .object({
    /**
     * 9 W11 D6 — 只清理闲置: busy channels are left completely alone (no
     * defer-flip either); default false keeps the original close-all.
     */
    idleOnly: z.boolean().optional(),
  })
  .strict();

/**
 * browser → server: ask for the current snapshot (9 W11 B). A tab bar that
 * mounted after an SPA navigation missed the connect-time push — this is its
 * catch-up. The ACK carries `chatChannelsPushSchema`.
 */
export const chatChannelsSyncRequestSchema = z.object({}).strict();

export type ChatChannelView = z.infer<typeof chatChannelViewSchema>;
export type ChatChannelsPush = z.infer<typeof chatChannelsPushSchema>;

export type CtlHandshakeAuth = z.infer<typeof ctlHandshakeAuthSchema>;
export type AppHandshakeAuth = z.infer<typeof appHandshakeAuthSchema>;
export type CtlDuplicateEvent = z.infer<typeof ctlDuplicateEventSchema>;
export type MachineHello = z.infer<typeof machineHelloSchema>;
export type MachineHelloAck = z.infer<typeof machineHelloAckSchema>;
export type MachineStatusEvent = z.infer<typeof machineStatusEventSchema>;
export type JobType = z.infer<typeof jobTypeSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobView = z.infer<typeof jobViewSchema>;
export type DeployJobPayload = z.infer<typeof deployJobPayloadSchema>;
export type HarnessAction = z.infer<typeof harnessActionSchema>;
export type HarnessJobPayload = z.infer<typeof harnessJobPayloadSchema>;
export type CreateMachineJobInput = z.infer<typeof createMachineJobSchema>;
export type JobUpdateEvent = z.infer<typeof jobUpdateEventSchema>;
export type JobDispatchEvent = z.infer<typeof jobDispatchEventSchema>;
export type JobProgressEvent = z.infer<typeof jobProgressEventSchema>;
export type JobResultEvent = z.infer<typeof jobResultEventSchema>;
export type InventoryScanRequest = z.infer<typeof inventoryScanRequestSchema>;
export type InventoryReportEvent = z.infer<typeof inventoryReportEventSchema>;
export type InventoryCollectRequest = z.infer<typeof inventoryCollectRequestSchema>;
export type InventoryPayloadEvent = z.infer<typeof inventoryPayloadEventSchema>;
export type InventoryUpdatedEvent = z.infer<typeof inventoryUpdatedEventSchema>;
export type AcpToolKind = z.infer<typeof acpToolKindSchema>;
export type AcpToolStatus = z.infer<typeof acpToolStatusSchema>;
export type AcpToolCallView = z.infer<typeof acpToolCallViewSchema>;
export type AcpToolContentItem = z.infer<typeof acpToolContentItemSchema>;
export type AcpPermissionOption = z.infer<typeof acpPermissionOptionSchema>;
export type ElicitationField = z.infer<typeof elicitationFieldSchema>;
export type PromptBlock = z.infer<typeof promptBlockSchema>;
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type SessionModeState = z.infer<typeof sessionModeStateSchema>;
export type SessionConfigValue = z.infer<typeof sessionConfigValueSchema>;
export type SessionConfigOption = z.infer<typeof sessionConfigOptionSchema>;
export type SessionConfigPatch = z.infer<typeof sessionConfigPatchSchema>;
export type PlanEntryStatus = z.infer<typeof planEntryStatusSchema>;
export type PlanEntry = z.infer<typeof planEntrySchema>;
export type AvailableCommandView = z.infer<typeof availableCommandViewSchema>;
export type PromptCapabilities = z.infer<typeof promptCapabilitiesSchema>;
export type ChatConfigSetRequest = z.infer<typeof chatConfigSetRequestSchema>;
export type ChatConfigSetEvent = z.infer<typeof chatConfigSetEventSchema>;
export type ChatStreamEventEnvelope = z.infer<typeof chatStreamEventEnvelopeSchema>;
export type ChatSessionOpenRequest = z.infer<typeof chatSessionOpenRequestSchema>;
export type ChatSessionStartEvent = z.infer<typeof chatSessionStartEventSchema>;
export type ChatSessionReadyEvent = z.infer<typeof chatSessionReadyEventSchema>;
export type ChatMessageSendRequest = z.infer<typeof chatMessageSendRequestSchema>;
export type ChatPromptEvent = z.infer<typeof chatPromptEventSchema>;
export type ChatTurnCancelEvent = z.infer<typeof chatTurnCancelEventSchema>;
export type ChatPermissionRespondRequest = z.infer<typeof chatPermissionRespondRequestSchema>;
export type ChatElicitationRespondRequest = z.infer<typeof chatElicitationRespondRequestSchema>;
export type ChatSessionCloseRequest = z.infer<typeof chatSessionCloseRequestSchema>;
export type ChatSessionClosedEvent = z.infer<typeof chatSessionClosedEventSchema>;
export type ChatSessionReadyPush = z.infer<typeof chatSessionReadyPushSchema>;
export type ChatSessionFailedPush = z.infer<typeof chatSessionFailedPushSchema>;
export type ChatSessionClosedPush = z.infer<typeof chatSessionClosedPushSchema>;
export type HistoryItem = z.infer<typeof historyItemSchema>;
export type ChatHistoryEvent = z.infer<typeof chatHistoryEventSchema>;
export type NativeSessionView = z.infer<typeof nativeSessionViewSchema>;
export type SessionsListRequest = z.infer<typeof sessionsListRequestSchema>;
export type SessionsListResultEvent = z.infer<typeof sessionsListResultEventSchema>;
export type AdapterProcessView = z.infer<typeof adapterProcessViewSchema>;
export type AdaptersReportResultEvent = z.infer<typeof adaptersReportResultEventSchema>;
