import { createModels, createProvider, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import * as anthropicMessagesApi from '@earendil-works/pi-ai/api/anthropic-messages';
import * as openaiCompletionsApi from '@earendil-works/pi-ai/api/openai-completions';
import * as openaiResponsesApi from '@earendil-works/pi-ai/api/openai-responses';
import type { ProviderApiKind, ProviderModelConfig } from '@harness-nexus/shared';
import { PROVIDER_DEFAULT_BASE_URLS } from '@harness-nexus/shared';

/**
 * The assistant's model construction (#52 §4): an LlmProvider row + its #51
 * registry entry + the decrypted credential → a pi-ai Model and a stream
 * function carrying the entry's advanced request options.
 *
 * Api mapping is 1:1 as W16 verified: anthropic→anthropic-messages,
 * openai-chat→openai-completions, openai-responses→openai-responses; baseUrl
 * rides verbatim (null = the kind's official endpoint, the same defaults
 * pi's own catalog uses). `topP`/`extraBody` ride `samplingParams` — merged
 * into the request body by the OpenAI-compatible adapters and ignored by
 * Anthropic's (the #51 warn-not-reject stance). `serverTools` ride a fetch
 * wrapper (#56) that APPENDS `{type}` entries into the request body's tools
 * array on the openai-responses and anthropic wires — append, never
 * replace: pi-ai's samplingParams merge is last-wins Object.assign and
 * would clobber the agent's own tools (research §4.2).
 */

/** pi-ai api id per provider kind (the subpath modules' wire). */
export type GatewayApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses';
export const PI_API_BY_KIND: Record<ProviderApiKind, GatewayApi> = {
  anthropic: 'anthropic-messages',
  'openai-chat': 'openai-completions',
  'openai-responses': 'openai-responses',
};

/**
 * Registry fields pi models structurally require but our registry treats as
 * optional — conservative fallbacks, never guessed high.
 */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 8_192;

const STREAMS_BY_API = {
  'anthropic-messages': {
    stream: anthropicMessagesApi.stream,
    streamSimple: anthropicMessagesApi.streamSimple,
  },
  'openai-completions': {
    stream: openaiCompletionsApi.stream,
    streamSimple: openaiCompletionsApi.streamSimple,
  },
  'openai-responses': {
    stream: openaiResponsesApi.stream,
    streamSimple: openaiResponsesApi.streamSimple,
  },
} as const;

export interface GatewayModel {
  model: Model<GatewayApi>;
  /** `Models.streamSimple` wrapped with the entry's request options. */
  streamFn: StreamFn;
}

export function buildGatewayModel(input: {
  kind: ProviderApiKind;
  /** null = the kind's official endpoint. */
  baseUrl: string | null;
  providerLabel: string;
  secret: string;
  entry: ProviderModelConfig;
}): GatewayModel {
  const api = PI_API_BY_KIND[input.kind];
  const baseUrl = input.baseUrl ?? PROVIDER_DEFAULT_BASE_URLS[input.kind];
  const provider = createProvider({
    id: 'harness-nexus-assistant',
    name: input.providerLabel,
    baseUrl,
    auth: {
      apiKey: {
        name: 'Credential by name',
        resolve: async () => ({ auth: { apiKey: input.secret }, source: 'credential' }),
      },
    },
    models: [
      {
        id: input.entry.id,
        name: input.entry.displayName ?? input.entry.id,
        api,
        provider: 'harness-nexus-assistant',
        baseUrl,
        input: input.entry.vision === true ? (['text', 'image'] as const) : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: input.entry.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
        maxTokens: input.entry.maxOutputTokens ?? FALLBACK_MAX_TOKENS,
      },
    ],
    api: STREAMS_BY_API[api],
  });

  const model = provider.getModels().find((m): m is Model<GatewayApi> => m.id === input.entry.id);
  if (model === undefined) {
    throw new Error(`gateway model "${input.entry.id}" missing after provider build`);
  }

  const models = createModels();
  models.setProvider(provider);

  const entry = input.entry;
  const samplingParams: Record<string, unknown> = {};
  if (entry.topP !== undefined) samplingParams.top_p = entry.topP;
  if (entry.extraBody !== undefined) Object.assign(samplingParams, entry.extraBody);

  // #56 — server tools append into the wire body via the fetch seam (both
  // pi-ai adapters hand options.fetch to their SDK client). openai-chat has
  // no tools[]-shaped server tools — nothing to inject there (UI warns).
  const serverTools =
    entry.serverTools !== undefined && input.kind !== 'openai-chat' ? entry.serverTools : [];

  const streamFn: StreamFn = (m, context, options) =>
    models.streamSimple(m, context, {
      ...(options ?? {}),
      ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
      ...(Object.keys(samplingParams).length > 0 ? { samplingParams } : {}),
      ...(serverTools.length > 0
        ? {
            fetch: serverToolsFetch(
              serverTools,
              (options as { fetch?: typeof globalThis.fetch } | undefined)?.fetch ??
                globalThis.fetch,
            ),
          }
        : {}),
    });

  return { model, streamFn };
}

/**
 * #56 — append `{type}` entries into a chat-shaped request body's tools
 * array. Pure: anything that is not a chat body (no `input`/`messages` —
 * model listings, auth probes) or not an object returns untouched.
 */
export function appendServerTools(body: unknown, serverTools: readonly string[]): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (!('input' in record) && !('messages' in record)) return body;
  const tools = Array.isArray(record.tools) ? record.tools : [];
  return { ...record, tools: [...tools, ...serverTools.map((t) => ({ type: t }))] };
}

/**
 * #56 — wrap a fetch so chat-request JSON bodies gain the server tools
 * before hitting the wire. Both pi-ai adapters pass `options.fetch` into
 * their OpenAI/Anthropic SDK client, which calls it with the serialized
 * JSON body in `init.body` — the one seam every wire crosses.
 */
export function serverToolsFetch(
  serverTools: readonly string[],
  inner: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    if (typeof init?.body === 'string') {
      try {
        const parsed: unknown = JSON.parse(init.body);
        const next = appendServerTools(parsed, serverTools);
        if (next !== parsed) return inner(input, { ...init, body: JSON.stringify(next) });
      } catch {
        // not a JSON body — pass through untouched
      }
    }
    return inner(input, init);
  };
}
