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
 * pi's own catalog uses). `topP`/`extraBody`/`serverTools` ride
 * `samplingParams` — merged into the request body by the OpenAI-compatible
 * adapters and ignored by Anthropic's (the #51 warn-not-reject stance).
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
  if (entry.serverTools !== undefined && input.kind === 'openai-responses') {
    samplingParams.tools = entry.serverTools.map((t) => ({ type: t }));
  }

  const streamFn: StreamFn = (m, context, options) =>
    models.streamSimple(m, context, {
      ...(options ?? {}),
      ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
      ...(Object.keys(samplingParams).length > 0 ? { samplingParams } : {}),
    });

  return { model, streamFn };
}
