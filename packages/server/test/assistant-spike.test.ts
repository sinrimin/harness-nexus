// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

/**
 * #52 S0 spike — the pi seams the assistant rides, verified OFFLINE (no
 * network, ever). Identity rides an explicit principal parameter through the
 * #53 service layer (Plan B, 2026-10-14) — the earlier in-process identity
 * sketches (AsyncLocalStorage — disproven through light-my-request — and the
 * boot-time internal credential) are the historical record in wiki
 * research-platform-assistant.md and are deliberately NOT tested here.
 *
 *  1. pi-ai `createProvider` accepts our gateway shape (registry models + a
 *     credential-resolving auth) and carries the model metadata through.
 *  2. A pi-agent-core `Agent` runs the loop with a CUSTOM tool + audit hooks
 *     against pi-ai's scripted FAUX provider — the harness pattern the
 *     AssistantService unit tests will reuse.
 */

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
