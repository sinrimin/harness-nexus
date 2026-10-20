// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import {
  appSocket,
  type AssistantLiveSessionView,
  type AssistantSessionsPush,
} from '@/realtime.js';

/**
 * #52 — the assistant rail's truth: the owner's assistant sessions with live
 * busy flags, kept current by `assistant:sessions` pushes. Mount also syncs
 * (`assistant:sessions.sync`) — the connect-time push predates SPA
 * navigations, the socket survives them.
 */
export function useAssistantSessions(): AssistantLiveSessionView[] {
  const [sessions, setSessions] = useState<AssistantLiveSessionView[]>([]);

  useEffect(() => {
    const socket = appSocket();
    const onPush = (push: AssistantSessionsPush): void => {
      setSessions(push.sessions);
    };
    socket.on('assistant:sessions', onPush);
    socket.emit('assistant:sessions.sync', {}, (snap: AssistantSessionsPush) => {
      if (snap && Array.isArray(snap.sessions)) setSessions(snap.sessions);
    });
    return () => {
      socket.off('assistant:sessions', onPush);
    };
  }, []);

  return sessions;
}
