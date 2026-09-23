import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useTheme } from 'next-themes';
import {
  DEFAULT_SKIN,
  getSkin,
  isSkinId,
  type SkinId,
  type SkinManifest,
} from '@/skins/registry';

/**
 * Skin axis of the theme system (the light/dark axis stays with next-themes).
 * Reads/writes the `hnx.skin` localStorage key (same family as `hnx.lang`),
 * mirrors it onto `<html data-skin=…>` (also set pre-paint by index.html), and
 * lazily injects the skin package via `manifest.load()`. When switching to a
 * single-mode skin while the other mode is active, the mode follows the skin.
 */

const STORAGE_KEY = 'hnx.skin';

interface SkinContextValue {
  skin: SkinId;
  manifest: SkinManifest;
  setSkin: (id: SkinId) => void;
}

const SkinContext = createContext<SkinContextValue | null>(null);

function readStoredSkin(): SkinId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isSkinId(stored) ? stored : DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

export function SkinProvider({ children }: { children: ReactNode }) {
  const [skin, setSkinState] = useState<SkinId>(readStoredSkin);
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    const manifest = getSkin(skin);
    document.documentElement.dataset.skin = skin;
    try {
      localStorage.setItem(STORAGE_KEY, skin);
    } catch {
      // Private mode etc. — the in-memory choice still applies.
    }
    void manifest.load();
    if (manifest.modes.length === 1) {
      const only = manifest.modes[0];
      if (only && resolvedTheme !== undefined && resolvedTheme !== only) setTheme(only);
    }
  }, [skin, resolvedTheme, setTheme]);

  const value: SkinContextValue = {
    skin,
    manifest: getSkin(skin),
    setSkin: setSkinState,
  };

  return <SkinContext.Provider value={value}>{children}</SkinContext.Provider>;
}

export function useSkin(): SkinContextValue {
  const ctx = useContext(SkinContext);
  if (!ctx) throw new Error('useSkin must be used within SkinProvider');
  return ctx;
}
