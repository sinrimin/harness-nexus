// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';
import { agentTargetSchema } from './profile.js';

/**
 * #110 — session pins. One store serves both rails; the PUT/DELETE body says
 * WHICH session by axis (the server composes the storage key — callers never
 * assemble or trust a raw key string). No existence check: a pin for a
 * session a listing never returns is an orphan, filtered at render and GC'd
 * by the service's listing guard — not the route's job to know better.
 */
export const sessionPinPutSchema = z.discriminatedUnion('axis', [
  z.object({
    axis: z.literal('assistant'),
    sessionId: z.string().min(1).max(128),
  }),
  z.object({
    axis: z.literal('machine'),
    machineId: z.string().min(1).max(128),
    target: agentTargetSchema,
    nativeSessionId: z.string().min(1).max(512),
  }),
]);
export type SessionPinPut = z.infer<typeof sessionPinPutSchema>;

export const sessionPinViewSchema = z.object({
  sessionKey: z.string(),
  pinnedAt: z.string(),
});
export type SessionPinView = z.infer<typeof sessionPinViewSchema>;

/**
 * The storage key — ONE definition shared by server and web (the rail matches
 * the GET listing's keys against live rows, so the format must never drift
 * between the two). The machine key carries the target: listings are per
 * agent INSTANCE, so the target segment keeps one instance's listing (and
 * its GC) from ever touching a sibling instance's pins.
 */
export function assistantPinKey(sessionId: string): string {
  return `assistant/${sessionId}`;
}

export function machinePinKey(machineId: string, target: string, nativeSessionId: string): string {
  return `machine/${machineId}/${target}/${nativeSessionId}`;
}

export function sessionPinKeyOf(input: SessionPinPut): string {
  return input.axis === 'assistant'
    ? assistantPinKey(input.sessionId)
    : machinePinKey(input.machineId, input.target, input.nativeSessionId);
}
