import { describe, expect, it } from 'vitest';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * #52 S0 spike — the three load-bearing seams of the platform assistant,
 * verified OFFLINE (no network, ever):
 *
 *  1. IDENTITY: AsyncLocalStorage does NOT survive light-my-request (verified
 *     on the rig — `app.inject()` dispatches outside the caller's async
 *     context), so tool identity rides a per-process random INTERNAL
 *     credential: `x-hnx-internal-auth` + `x-hnx-actor` headers, trusted only
 *     on an exact match against a boot-time secret that never leaves memory.
 *     Network clients cannot know the secret; restarts rotate it.
 *  2. pi-ai `createProvider` accepts our gateway shape (registry models + a
 *     credential-resolving auth) and carries the model metadata through.
 *  3. A pi-agent-core `Agent` runs the loop with a CUSTOM tool + audit hooks
 *     against pi-ai's scripted FAUX provider — the harness pattern the
 *     AssistantService unit tests will reuse.
 */

const INTERNAL_AUTH_HEADER = 'x-hnx-internal-auth';
const ACTOR_HEADER = 'x-hnx-actor';

/** The boot-time secret pattern the real auth plugin will hold. */
const internalAuthSecret = randomBytes(32).toString('base64url');
const internalAuthOk = (presented: unknown): boolean => {
  if (typeof presented !== 'string' || presented.length !== internalAuthSecret.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(presented), Buffer.from(internalAuthSecret));
};

/** The minimal shape of the root auth hook's internal branch (#52). */
function internalActorOf(headers: Record<string, unknown>): string | null {
  return internalAuthOk(headers[INTERNAL_AUTH_HEADER])
    ? typeof headers[ACTOR_HEADER] === 'string' && headers[ACTOR_HEADER] !== ''
      ? headers[ACTOR_HEADER]
      : null
    : null;
}

// ---- 1. internal-credential identity through app.inject() ----

describe('#52 spike — internal actor credential through app.inject()', () => {
  let app: FastifyInstance;

  it('the auth hook adopts the actor on an exact secret match, rejects everything else', async () => {
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      const actorId = internalActorOf(req.headers as Record<string, unknown>);
      // Real hook: fresh findUserById(actorId) here — disabled/demoted users
      // fall through to anonymous. This spike proves the transport, not the lookup.
      (req as unknown as { actor?: string | null }).actor = actorId;
    });
    app.get('/whoami', async (req) => ({
      actor: (req as unknown as { actor?: string | null }).actor ?? null,
    }));
    await app.ready();

    const inside = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { [INTERNAL_AUTH_HEADER]: internalAuthSecret, [ACTOR_HEADER]: 'u-1' },
    });
    expect(inside.json()).toEqual({ actor: 'u-1' });

    // Wrong secret / missing secret / missing actor → anonymous (Bearer path).
    const badSecret = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { [INTERNAL_AUTH_HEADER]: randomBytes(32).toString('base64url'), [ACTOR_HEADER]: 'u-1' },
    });
    expect(badSecret.json()).toEqual({ actor: null });
    const noHeaders = await app.inject({ method: 'GET', url: '/whoami' });
    expect(noHeaders.json()).toEqual({ actor: null });
    await app.close();
  });
});

// ---- 2 + 3. pi-ai custom provider shape & the agent loop (faux, offline) ----

describe('#52 spike — pi-ai gateway provider + pi-agent-core loop', () => {
  it('createProvider carries registry model metadata; the agent loop runs a custom tool with audit hooks', async () => {
    const piAi = await import('@earendil-works/pi-ai');
    const { Agent } = await import('@earendil-works/pi-agent-core');

    // The faux provider plays the wire: scripted assistant messages, no I/O.
    const faux = piAi.fauxProvider({
      models: [{ id: 'gw-large', name: 'Gateway Large', contextWindow: 256_000 }],
      tokensPerSecond: 10_000,
    });
    const models = piAi.createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel('gw-large');
    expect(model.contextWindow).toBe(256_000); // registry metadata rides the Model

    // Our gateway provider construction path (shape only — nothing dialed):
    // registry rows → ProviderModel entries, the api adapters passed by
    // reference from their per-wire modules ({stream, streamSimple}).
    const openaiCompletions = await import('@earendil-works/pi-ai/api/openai-completions');
    const gateway = piAi.createProvider({
      id: 'harness-nexus',
      name: 'team-gateway',
      baseUrl: 'https://gw.example.com/v1',
      auth: {
        apiKey: {
          name: 'Credential by name',
          resolve: async () => ({ auth: { apiKey: 'sk-decrypted' }, source: 'credential' }),
        },
      },
      models: [
        {
          id: 'gw-large',
          name: 'Gateway Large',
          api: 'openai-completions',
          contextWindow: 256_000,
          maxTokens: 32_000,
          reasoning: false,
        },
      ],
      api: {
        stream: openaiCompletions.stream,
        streamSimple: openaiCompletions.streamSimple,
      },
    });
    expect(gateway.id).toBe('harness-nexus');
    expect(gateway.getModels()[0]!.name).toBe('Gateway Large');

    // The tool: typebox parameters (pi-native), the audit seam fires.
    const audit: string[] = [];
    const echoTool = {
      name: 'echo',
      label: 'Echo',
      description: 'Echoes its input',
      parameters: piAi.Type.Object({ text: piAi.Type.String() }),
      execute: async (_id: string, params: { text: string }) => ({
        content: [{ type: 'text' as const, text: `echo:${params.text}` }],
        details: {},
      }),
    };

    const agent = new Agent({
      initialState: {
        systemPrompt: 'You are the platform assistant (spike).',
        model,
        tools: [echoTool],
        messages: [],
      },
      streamFn: models.streamSimple.bind(models),
      beforeToolCall: async ({ toolCall }) => {
        audit.push(`before:${toolCall.name}`);
        return undefined; // allow — this is the group-gate + audit seam
      },
      afterToolCall: async ({ toolCall }) => {
        audit.push(`after:${toolCall.name}`);
        return undefined;
      },
    });

    const seen: string[] = [];
    agent.subscribe((event) => {
      seen.push(event.type);
    });

    // Script: turn 1 asks for the tool, turn 2 concludes.
    faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxToolCall('echo', { text: 'hi' })]),
      piAi.fauxAssistantMessage([piAi.fauxText('tool ran')]),
    ]);

    await agent.prompt('run the echo tool');

    expect(audit).toEqual(['before:echo', 'after:echo']);
    expect(seen).toContain('message_update'); // streaming deltas flow
    expect(seen).toContain('tool_execution_end');
    expect(seen).toContain('turn_end');
    expect(seen).toContain('agent_end');
    const last = agent.state.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect((last?.content ?? []).some((c) => c.type === 'text')).toBe(true);
  });
});
