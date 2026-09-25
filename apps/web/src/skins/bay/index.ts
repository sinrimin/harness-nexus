/**
 * BAY — the instrument-rack skin. Light aluminium chassis, dark LCD wells,
 * LEDs for status, safety-orange for the one energised thing per screen.
 * Design source: docs/dev/theme-designs/01-bay (local comps) + BRIEF-01-BAY.
 * Light-only for now (the comp defines the light chassis; a dark variant is
 * a deliberate later step, not a mechanical invert).
 */

import { loadBayFonts } from './fonts.js';

interface BaySkin {
  id: 'bay';
  nameKey: 'app.skinBay';
  modes: ['light'];
  statusStyle: 'led';
  topology: 'constellation';
  load: () => Promise<unknown>;
}

export const baySkin: BaySkin = {
  id: 'bay',
  nameKey: 'app.skinBay',
  modes: ['light'],
  statusStyle: 'led',
  topology: 'constellation',
  load: async () => {
    await Promise.all([loadBayFonts(), import('./tokens.css'), import('./skin.css')]);
  },
};
