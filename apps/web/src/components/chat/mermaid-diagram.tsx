// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTheme } from 'next-themes';
import { Skeleton } from '@/components/kit';
import { useSkin } from '@/components/skin-provider';
import { useI18n } from '@/i18n';

/**
 * Mermaid diagram (#93) — where `language-mermaid` fences land. The library is
 * lazy: only the first fence pays the dynamic `import('mermaid')` (the ~1 MB
 * stays out of the main chunk), bundled — the no-CDN rule generalizes to every
 * asset. Source text is untrusted (agent output), so `securityLevel: 'strict'`
 * keeps labels sanitized and click-interactions off. Any parse failure —
 * including a streaming half-fence — falls back to the caller's plain code
 * block. Mermaid is a module-level singleton: `initialize` + `render` pairs are
 * serialized through one queue so concurrent fences cannot interleave a theme
 * change into another diagram's render.
 *
 * The palette is TOKEN-driven, not mermaid's built-in `neutral`/`dark` guesses.
 * A skin may re-scope the well it sits in (BAY paints `[data-surface='well']`
 * as a dark LCD and re-points `--foreground`/`--background` there), so the
 * tokens are read from the HOST element — and the base theme is picked from
 * the resolved surface's luminance, not next-themes' mode. `useSkin()` is an
 * effect dependency, so switching skins re-resolves and re-renders.
 */

type MermaidApi = (typeof import('mermaid'))['default'];

let apiPromise: Promise<MermaidApi> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let seq = 0;

function loadMermaid(): Promise<MermaidApi> {
  apiPromise ??= import('mermaid').then((m) => {
    m.default.initialize({ startOnLoad: false, securityLevel: 'strict' });
    return m.default;
  });
  return apiPromise;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/** 1×1 canvas normalizes any CSS Color 4 value (oklch, color-mix, …) to sRGB. */
let colorProbe: CanvasRenderingContext2D | null | undefined;

function probe(): CanvasRenderingContext2D | null {
  if (colorProbe === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    colorProbe = canvas.getContext('2d', { willReadFrequently: true });
  }
  return colorProbe;
}

function parseColor(value: string): Rgba | null {
  if (value === '') return null;
  const ctx = probe();
  if (ctx === null) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = 'black';
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  const r = data[0] ?? 0;
  const g = data[1] ?? 0;
  const b = data[2] ?? 0;
  const a = (data[3] ?? 0) / 255;
  return a === 0 ? null : { r, g, b, a };
}

function over(top: Rgba, bottom: Rgba): Rgba {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  };
}

function luminance(c: Rgba): number {
  const channel = (v: number): number => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function cssRgb(c: Rgba): string {
  return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
}

/** The opaque surface behind the diagram: composite the ancestor backgrounds. */
function resolveSurface(el: HTMLElement): Rgba {
  const layers: Rgba[] = [];
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    const color = parseColor(getComputedStyle(node).backgroundColor);
    if (color !== null) layers.push(color);
  }
  let surface = WHITE;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer !== undefined) surface = over(layer, surface);
  }
  return surface;
}

/**
 * A token from the host's computed style. System colors are the non-browser
 * fallback (jsdom has no canvas): mermaid only sees them in tests, which mock
 * the library anyway.
 */
function tokenColor(el: HTMLElement, name: string, fallback: string): Rgba {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  return parseColor(raw === '' ? fallback : raw) ?? parseColor(fallback) ?? BLACK;
}

interface Palette {
  dark: boolean;
  fontFamily: string;
  /** Node body: the ink (inverted against the surface) — clears 3:1 on it. */
  nodeFill: string;
  /** Node label: the page ground, which contrasts with the ink body. */
  nodeText: string;
  /** General text on the surface (edge labels, titles, note text). */
  text: string;
  /** Edges: the dim ink, unless it fails 3:1 on this surface. */
  edge: string;
  /** Opaque surface so edge-label boxes mask the lines they sit on. */
  surface: string;
}

function resolvePalette(el: HTMLElement): Palette {
  const surface = resolveSurface(el);
  const dark = luminance(surface) < 0.4;
  const foreground = tokenColor(el, '--foreground', 'CanvasText');
  const background = tokenColor(el, '--background', 'Canvas');
  const muted = tokenColor(el, '--muted-foreground', 'GrayText');
  const edge = contrast(muted, surface) >= 3 ? muted : foreground;
  return {
    dark,
    fontFamily: getComputedStyle(el).getPropertyValue('--app-font-sans').trim(),
    nodeFill: cssRgb(foreground),
    nodeText: cssRgb(background),
    text: cssRgb(foreground),
    edge: cssRgb(edge),
    surface: cssRgb(surface),
  };
}

/** Mermaid theme variables shared by every diagram family it renders. */
function themeVariables(p: Palette): Record<string, string | boolean> {
  return {
    darkMode: p.dark,
    background: 'transparent',
    fontFamily: p.fontFamily,
    // Flowchart / state / class bodies.
    primaryColor: p.nodeFill,
    primaryTextColor: p.nodeText,
    primaryBorderColor: p.nodeFill,
    mainBkg: p.nodeFill,
    nodeBorder: p.nodeFill,
    nodeTextColor: p.nodeText,
    secondaryColor: p.surface,
    secondaryTextColor: p.text,
    secondaryBorderColor: p.edge,
    tertiaryColor: p.surface,
    tertiaryTextColor: p.text,
    tertiaryBorderColor: p.edge,
    clusterBkg: p.surface,
    clusterBorder: p.edge,
    // Edges + labels.
    lineColor: p.edge,
    textColor: p.text,
    titleColor: p.text,
    edgeLabelBackground: p.surface,
    // Sequence / journey / gantt families.
    actorBkg: p.nodeFill,
    actorBorder: p.nodeFill,
    actorTextColor: p.nodeText,
    actorLineColor: p.edge,
    signalColor: p.edge,
    signalTextColor: p.text,
    labelBoxBkgColor: p.nodeFill,
    labelBoxBorderColor: p.nodeFill,
    labelTextColor: p.nodeText,
    loopTextColor: p.text,
    noteBkgColor: p.surface,
    noteTextColor: p.text,
    noteBorderColor: p.edge,
    activationBkgColor: p.nodeFill,
    activationBorderColor: p.edge,
    sequenceNumberColor: p.nodeText,
  };
}

/**
 * `.label` (node AND edge labels) reads one variable, `nodeTextColor`; an ink
 * node body and the surface behind an edge label need opposite inks. Mermaid's
 * `themeCSS` is the extension point: edge labels sit on the surface and take
 * the surface ink, matching every other word printed on the well.
 */
function edgeLabelCss(p: Palette): string {
  return [
    `.edgeLabel, .edgeLabel p, .edgeLabel .labelBkg, .edgeLabel rect { background-color: ${p.surface}; fill: ${p.surface}; }`,
    `.edgeLabel .label span, .edgeLabel span, .edgeLabel p { color: ${p.text}; }`,
  ].join('\n');
}

export function MermaidDiagram({ code, fallback }: { code: string; fallback: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const { skin, manifest } = useSkin();
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const svgHostRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [bind, setBind] = useState<((el: Element) => void) | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setBind(null);
    setFailed(false);
    const id = `hnx-mermaid-${++seq}`;
    (async () => {
      try {
        // A skin loads lazily: wait for its tokens (and the faces they pick)
        // before resolving colors, or a switch would theme with the old skin.
        await manifest.load();
        if (typeof document.fonts !== 'undefined') await document.fonts.ready;
        await new Promise<void>((resolve) => {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
          else setTimeout(resolve, 0);
        });
        if (cancelled) return;
        const host = hostRef.current;
        if (host === null) throw new Error('mermaid host unmounted');
        const palette = resolvePalette(host);
        const mermaid = await loadMermaid();
        const parsed = await mermaid.parse(code, { suppressErrors: true });
        if (cancelled) return;
        if (!parsed) throw new Error('parse failed');
        const job = renderQueue.then(async () => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            look: 'classic',
            theme: palette.dark ? 'dark' : 'neutral',
            darkMode: palette.dark,
            fontFamily: palette.fontFamily || undefined,
            themeVariables: themeVariables(palette),
            themeCSS: edgeLabelCss(palette),
          });
          return mermaid.render(id, code);
        });
        renderQueue = job.catch(() => undefined);
        const result = await job;
        if (cancelled) return;
        setBind(() => result.bindFunctions ?? null);
        setSvg(result.svg);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, resolvedTheme, skin, manifest]);

  // Tooltip/click bindings attach to the committed SVG, not the markup string.
  useEffect(() => {
    if (svg !== null && bind !== null && svgHostRef.current) bind(svgHostRef.current);
  }, [svg, bind]);

  if (failed) return <>{fallback}</>;
  return (
    <div ref={hostRef} className="p-3">
      {svg === null ? (
        <Skeleton className="h-24 w-3/4" />
      ) : (
        <div
          ref={svgHostRef}
          role="img"
          aria-label={t('common.diagram')}
          className="overflow-x-auto [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}
