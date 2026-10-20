// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { Navigate } from 'react-router-dom';
import { readDefaultEnd } from '@/components/chat/end-switcher.js';

/**
 * #52 — the Chat entry is the DEFAULT 端's session list, not a cards page
 * (the agent-cards screen retired with the 端 switcher). The pinned 端 lives
 * in `localStorage hnx.chat.defaultEnd`; the initial default is the
 * assistant. The target page's rail carries the switcher + the pin star.
 */
export function ChatPage() {
  const end = readDefaultEnd();
  if (end.startsWith('agent:') && end.length > 'agent:'.length) {
    return <Navigate to={`/chat/agents/${end.slice('agent:'.length)}`} replace />;
  }
  return <Navigate to="/chat/assistants" replace />;
}
