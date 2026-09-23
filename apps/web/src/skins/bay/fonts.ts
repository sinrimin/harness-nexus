/**
 * BAY font loader — only pulled (and only paid for) when the skin is active.
 * Explicit .css paths keep TS happy via vite/client's module declarations.
 */
export function loadBayFonts(): Promise<unknown> {
  return Promise.all([
    import('@fontsource-variable/archivo/index.css'),
    import('@fontsource/archivo-narrow/500.css'),
    import('@fontsource/archivo-narrow/600.css'),
    import('@fontsource/archivo-narrow/700.css'),
    import('@fontsource/jetbrains-mono/400.css'),
    import('@fontsource/jetbrains-mono/500.css'),
    import('@fontsource/jetbrains-mono/700.css'),
  ]);
}
