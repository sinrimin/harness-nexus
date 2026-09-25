/**
 * Harness Nexus brand mark.
 *
 * The glyph is the hexagonal ribbon: three interlocking ribbons (bright /
 * medium / deep brand blue) folding into an "HN" — the mark carries its own
 * brand palette (`--brand-*`), deliberately separate from the UI's single
 * `--signal` accent. The deep navy is lifted in dark theme so the mark stays
 * readable on dark chrome.
 *
 * Mark + wordmark are inline SVG/text (no image asset) so they scale crisply
 * at any size, and the favicon mirrors the same shape.
 */

type BrandMarkProps = {
  /** Mark width in px; height tracks the glyph's ~101.8:116 aspect. */
  size?: number;
  className?: string;
};

function BrandMark({ size = 28, className }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={Math.round((size * 116) / 101.8)}
      viewBox="42.5 42 101.8 116"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="var(--brand-bright)"
        d="M93.6 42 L144.3 71 L144.3 129 L126.9 138.2 L126.9 82.6 L94 62.8 L92.5 63 L92.5 42.6 Z"
      />
      <path fill="var(--brand-mid)" d="M93.6 42 L74.9 53.4 L74.9 91.8 L93.7 81 Z" />
      <path
        fill="var(--brand-deep)"
        d="M59.7 62 L42.5 73.6 L42.5 128.9 L58.9 137.7 L93.6 116.4 L93.8 158 L110.6 148.3 L110.6 89.6 L59.7 118.2 Z"
      />
    </svg>
  );
}

function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      Harness<span className="text-brand-mid">Nexus</span>
    </span>
  );
}

/** Mark + wordmark, locked up as the masthead unit. */
export function Brand({ size = 24, className }: BrandMarkProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <BrandMark size={size} />
      <Wordmark className="text-foreground text-[15px] font-semibold tracking-tight" />
    </span>
  );
}
