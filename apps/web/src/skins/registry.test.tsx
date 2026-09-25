// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import { SkinProvider } from '@/components/skin-provider';
import { TOPOLOGY_RENDERERS, topologyRenderer } from '@/components/topology';
import { MeshTopology } from '@/components/mesh-topology';
import { PlateTopology } from '@/components/plate-topology';
import { RadarTopology } from '@/components/radar-topology';
import { Region } from '@/components/kit/region';
import { Lamp } from '@/components/kit';
import { SKINS, isSkinId, type TopologyStyle } from './registry';

/**
 * The skeleton's promises to a skin (README §6, `04-contract.md §3`).
 *
 * P7's flexibility drill ran these against a real placeholder skin in a real
 * browser; the parts a unit test can hold forever are asserted here, because a
 * promise that only lives in a doc is a promise nobody keeps:
 *
 *   1. every `data-region` slot is a Region that costs nothing while empty;
 *   2. `statusStyle` really replaces the status rendering (and the truth stays
 *      on `data-state`);
 *   3. all three `topology` keys resolve to a real renderer;
 *   5. the accent can be withdrawn without losing "current";
 *   plus the two hard skin rules, which are grep-able and therefore testable:
 *   no `content:` text injection and no negative-margin layout surgery.
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
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })),
  );
});

afterEach(cleanup);

function withProviders(node: React.ReactNode, skin: string) {
  localStorage.setItem('hnx.skin', skin);
  return render(
    <I18nProvider>
      <SkinProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </SkinProvider>
    </I18nProvider>,
  );
}

describe('region slots', () => {
  it('renders nothing at all while empty, so an empty slot has no footprint', () => {
    const { container } = render(<Region region="marginalia" side="end" />);
    expect(container.querySelector("[data-region='marginalia']")).toBeNull();
  });

  it('renders the region as soon as a page fills it', () => {
    const { container } = render(
      <Region region="marginalia" side="end">
        <p>folio note</p>
      </Region>,
    );
    const region = container.querySelector("[data-region='marginalia']");
    expect(region).not.toBeNull();
    expect(region?.getAttribute('data-side')).toBe('end');
    expect(region?.textContent).toBe('folio note');
  });
});

describe('status rendering is replaceable', () => {
  it('draws a lamp body and keeps the truth on data-state on the default skin', () => {
    withProviders(<Lamp state="online" word="Online" />, 'signal');
    const lamp = document.querySelector("[data-slot='lamp']");
    expect(lamp?.getAttribute('data-lamp')).toBe('dot');
    expect(lamp?.getAttribute('data-state')).toBe('online');
    expect(lamp?.querySelector("[data-slot='lamp-body']")).not.toBeNull();
  });
});

describe('topology registry', () => {
  it('resolves every key the type system offers to a renderer', () => {
    const keys: TopologyStyle[] = ['constellation', 'plate', 'radar'];
    expect(Object.keys(TOPOLOGY_RENDERERS).sort()).toEqual([...keys].sort());
    expect(topologyRenderer('constellation')).toBe(MeshTopology);
    expect(topologyRenderer('plate')).toBe(PlateTopology);
    // Not a fallback any more: P7 built the radar renderer, so the key means
    // something (04-contract.md §3 — "别只兜底").
    expect(topologyRenderer('radar')).toBe(RadarTopology);
  });

  it('falls back only for a key outside the union', () => {
    expect(topologyRenderer('nonsense' as TopologyStyle)).toBe(MeshTopology);
  });
});

describe('the skin registry', () => {
  it('accepts exactly the declared ids', () => {
    expect(isSkinId('bay')).toBe(true);
    expect(isSkinId('nope')).toBe(false);
  });

  it('declares a manifest field set the runtime actually reads', () => {
    for (const skin of SKINS) {
      expect(skin.modes.length).toBeGreaterThan(0);
      // `statusStyle` and `topology` are consumed (kit/lamp.tsx, topology.ts);
      // a manifest field with no consumer is how `widgets` rotted.
      expect(['dot', 'led', 'lamp', 'word']).toContain(skin.statusStyle);
      expect(Object.keys(TOPOLOGY_RENDERERS)).toContain(skin.topology);
    }
  });
});

describe('the two hard rules for skins (04-contract.md §3)', () => {
  const skinsDir = join(__dirname);
  const cssFiles = readdirSync(skinsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(skinsDir, d.name, 'skin.css'))
    .filter((f) => {
      try {
        readFileSync(f);
        return true;
      } catch {
        return false;
      }
    });

  it('finds the skins to check', () => {
    expect(cssFiles.length).toBeGreaterThan(0);
  });

  /** Comments explain the rule; they must not be mistaken for breaking it. */
  const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('never writes business text with content:', () => {
    for (const file of cssFiles) {
      const css = withoutComments(readFileSync(file, 'utf8'));
      // `content: ''` (or a symbol) is decoration and stays legal; anything
      // with words in it is data that CSS cannot know (the bay numbers were
      // injected exactly this way and could never follow the nav manifest).
      const injected = [...css.matchAll(/content:\s*(['"])(.*?)\1/g)]
        .map((m) => m[2] ?? '')
        .filter((text) => /[A-Za-z0-9\u4e00-\u9fff]/.test(text));
      expect(injected, `${file} injects text`).toEqual([]);
    }
  });

  it('never tears a component open with a negative margin', () => {
    for (const file of cssFiles) {
      const css = withoutComments(readFileSync(file, 'utf8'));
      const negative = [...css.matchAll(/margin[a-z-]*:\s*(-[^;]+)/g)].map((m) => m[1]);
      expect(negative, `${file} uses a negative margin`).toEqual([]);
    }
  });
});
