// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import { SkinProvider } from '@/components/skin-provider';
import { ChatStream } from './chat-stream';
import { createFoldState, fold } from './fold';

/**
 * #128/#88 — the stream-level dispatch of the merged action row: the turn
 * tail joins the LAST step's action row only when that step is capturable;
 * a cancelled turn (interrupted last step + cancelled tail) must render the
 * tail exactly ONCE — the original merge passed the stats on position alone
 * and double-rendered it (in-step fallback + standalone row).
 */

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <SkinProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </SkinProvider>
    </I18nProvider>
  );
}

/** A turn cancelled mid-text: an interrupted text step, then the tail. */
function cancelledTurnState() {
  let state = createFoldState();
  state = fold(state, {
    type: 'event',
    event: { kind: 'user_message', blocks: [{ type: 'text', text: 'go' }] },
  });
  state = fold(state, {
    type: 'event',
    event: { kind: 'message_delta', delta: 'partial answer' },
  });
  state = fold(state, {
    type: 'event',
    event: { kind: 'turn_result', stopReason: 'cancelled' },
  });
  return state;
}

describe('ChatStream tail dispatch', () => {
  it('a cancelled turn renders its tail exactly once (no in-step merge)', () => {
    const state = cancelledTurnState();
    expect(state.rows.some((r) => r.row === 'turn-tail')).toBe(true);
    const { container } = render(
      <ChatStream
        state={state}
        cwd="/w"
        sessionId="s1"
        onPermissionRespond={() => {}}
        onElicitationRespond={() => {}}
        onCaptureStep={() => {}}
      />,
      { wrapper: Providers },
    );
    // TurnTail prints the 'cancelled' marker — exactly once across the DOM
    // (the original bug printed it twice: in-step fallback + standalone row).
    const text = container.textContent ?? '';
    expect(text.split('cancelled').length - 1).toBe(1);
    // And no action row exists to merge into (the step never settled).
    expect(container.querySelector('.justify-between')).toBeNull();
  });

  it('a settled capturable turn renders its tail inside the action row only', () => {
    let state = createFoldState();
    state = fold(state, {
      type: 'event',
      event: { kind: 'user_message', blocks: [{ type: 'text', text: 'go' }] },
    });
    state = fold(state, {
      type: 'event',
      event: { kind: 'message_delta', delta: 'full answer' },
    });
    state = fold(state, { type: 'event', event: { kind: 'turn_result', stopReason: 'end_turn' } });
    const { container } = render(
      <ChatStream
        state={state}
        cwd="/w"
        sessionId="s1"
        onPermissionRespond={() => {}}
        onElicitationRespond={() => {}}
        onCaptureStep={() => {}}
      />,
      { wrapper: Providers },
    );
    const row = container.querySelector('.justify-between');
    expect(row).not.toBeNull();
    // The tail lives inside the merged row (usage-less tail renders nothing
    // visible; the row's two icon buttons are the merge evidence) and no
    // second copy sits outside it.
    const actionRows = container.querySelectorAll('.justify-between');
    expect(actionRows.length).toBe(1);
  });
});
