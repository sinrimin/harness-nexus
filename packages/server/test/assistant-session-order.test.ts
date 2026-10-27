// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { listAssistantSessions } from '../src/services/assistant.js';
import type { Principal } from '../src/services/principal.js';
import type { AssistantSession } from '@harness-nexus/core';

/**
 * #94 — the storage contract behind the assistant session rail: listings are
 * NEWEST ACTIVITY FIRST (lastMessageAt, falling back to createdAt, createdAt
 * as the tiebreak). The web renders this order verbatim; it used to .reverse()
 * it into oldest-first, which is the bug. This pins the contract both drivers
 * (sqlite's COALESCE ORDER BY and the memory sort) must keep speaking.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };

function session(id: string, createdAt: string, lastMessageAt: string | null): AssistantSession {
  return {
    id,
    ownerId: owner.userId,
    assistantId: 'a-1',
    title: id,
    createdAt,
    updatedAt: lastMessageAt ?? createdAt,
    lastMessageAt,
  };
}

describe('listAssistantSessions order (#94)', () => {
  it('lists newest activity first, createdAt breaking ties', async () => {
    const uow = createMemoryUnitOfWork();
    await uow.assistants.saveSession(session('s-old', '2026-01-01T00:00:00.000Z', null));
    await uow.assistants.saveSession(
      session('s-active', '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
    );
    // Same lastMessageAt → the later-created row wins the top.
    await uow.assistants.saveSession(
      session('s-tie-a', '2026-01-02T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
    );
    await uow.assistants.saveSession(
      session('s-tie-b', '2026-01-03T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
    );
    await uow.assistants.saveSession(
      session('s-recent', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
    );

    const listed = await listAssistantSessions({ uow }, owner);
    expect(listed.map((s) => s.id)).toEqual([
      's-tie-b',
      's-tie-a',
      's-active',
      's-recent',
      's-old',
    ]);
  });

  it('scopes to the owner and the optional assistant filter, order intact', async () => {
    const uow = createMemoryUnitOfWork();
    await uow.assistants.saveSession(session('mine', '2026-01-01T00:00:00.000Z', null));
    await uow.assistants.saveSession({
      ...session('theirs', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
      ownerId: 'u-other',
    });
    await uow.assistants.saveSession({
      ...session('other-config', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
      assistantId: 'a-2',
    });

    const mine = await listAssistantSessions({ uow }, owner);
    expect(mine.map((s) => s.id)).toEqual(['other-config', 'mine']);
    const oneConfig = await listAssistantSessions({ uow }, owner, 'a-2');
    expect(oneConfig.map((s) => s.id)).toEqual(['other-config']);
  });
});
