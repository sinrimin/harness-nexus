// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTheme } from 'next-themes';
import { Skeleton } from '@/components/kit';
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

/** The skin's text stack, resolved at render time so a skin switch is honored. */
function appFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--app-font-sans').trim();
}

export function MermaidDiagram({ code, fallback }: { code: string; fallback: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
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
            theme: resolvedTheme === 'dark' ? 'dark' : 'neutral',
            fontFamily: appFont() || undefined,
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
  }, [code, resolvedTheme]);

  // Tooltip/click bindings attach to the committed SVG, not the markup string.
  useEffect(() => {
    if (svg !== null && bind !== null && hostRef.current) bind(hostRef.current);
  }, [svg, bind]);

  if (failed) return <>{fallback}</>;
  return (
    <div className="p-3">
      {svg === null ? (
        <Skeleton className="h-24 w-3/4" />
      ) : (
        <div
          ref={hostRef}
          role="img"
          aria-label={t('common.diagram')}
          className="overflow-x-auto [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}
