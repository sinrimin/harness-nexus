/**
 * BAY font loader — only pulled (and only paid for) when the skin is active.
 * Explicit .css paths keep TS happy via vite/client's module declarations.
 *
 * Every entry is the LATIN subset. The package sheets declare latin-ext /
 * vietnamese / cyrillic / greek as well and vite copies every file they
 * reference; a machined-panel skin set in Latin-only chat and resource text
 * pays for none of it (`archivo-latin.css` declares the variable face by hand,
 * because the variable packages ship no per-subset sheet).
 */
export function loadBayFonts(): Promise<unknown> {
  return Promise.all([
    import('./archivo-latin.css'),
    import('@fontsource/archivo-narrow/latin-500.css'),
    import('@fontsource/archivo-narrow/latin-600.css'),
    import('@fontsource/archivo-narrow/latin-700.css'),
    import('@fontsource/jetbrains-mono/latin-400.css'),
    import('@fontsource/jetbrains-mono/latin-500.css'),
    import('@fontsource/jetbrains-mono/latin-700.css'),
  ]);
}
