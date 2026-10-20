// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import { appSocket, type ChatChannelView, type ChatChannelsPush } from '@/realtime.js';

/**
 * 9 W11 B — the user's live-channel snapshot, kept current by the server's
 * `chat:channels` pushes (initial truth arrives on /app connect; every table
 * change re-pushes). Mount wherever channel truth is rendered (the tab bar on
 * both chat pages) — multiple mounts share the one /app socket harmlessly.
 *
 * MOUNT also syncs: the connect-time push predates this mount whenever the
 * SPA navigated (the socket survives navigation), so the hook asks for the
 * current snapshot once via `chat:channels.sync` instead of waiting for the
 * next table change to learn the truth.
 */
export function useChatChannels(): ChatChannelView[] {
  const [channels, setChannels] = useState<ChatChannelView[]>([]);

  useEffect(() => {
    const socket = appSocket();
    const onPush = (push: ChatChannelsPush): void => {
      setChannels(push.channels);
    };
    socket.on('chat:channels', onPush);
    socket.emit('chat:channels.sync', {}, (snap: ChatChannelsPush) => {
      if (snap && Array.isArray(snap.channels)) setChannels(snap.channels);
    });
    return () => {
      socket.off('chat:channels', onPush);
    };
  }, []);

  return channels;
}
