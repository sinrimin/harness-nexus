// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { NoteStatus, NoteVisibility } from '@harness-nexus/sdk';
import type { SignalState } from '@/components/state-signal';
import type { TranslationKey } from '@/i18n';

/**
 * Notes vocabulary (#88) — the one place the wire values meet the UI's words
 * and lamps. Statuses are a reading pipeline, not a health signal: only
 * `reading` is the live/working state; `read` is completed, `inbox`/`to_read`
 * are the quiet upstream states.
 */

export const NOTE_STATUS_KEY: Record<NoteStatus, TranslationKey> = {
  inbox: 'notes.statusInbox',
  to_read: 'notes.statusToRead',
  reading: 'notes.statusReading',
  read: 'notes.statusRead',
};

export const NOTE_STATUS_STATE: Record<NoteStatus, SignalState> = {
  inbox: 'neutral',
  to_read: 'configured',
  reading: 'live',
  read: 'completed',
};

export const NOTE_STATUSES: NoteStatus[] = ['inbox', 'to_read', 'reading', 'read'];

export function visibilityKey(visibility: NoteVisibility): TranslationKey {
  return visibility === 'public' ? 'notes.publicChip' : 'notes.privateChip';
}

/** Feed cards show the short `10-21`; detail shows the full stamp. */
export function shortDate(iso: string, lang: string): string {
  return new Date(iso).toLocaleDateString(lang, { month: '2-digit', day: '2-digit' });
}

export function fullDate(iso: string, lang: string): string {
  return new Date(iso).toLocaleString(lang, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
