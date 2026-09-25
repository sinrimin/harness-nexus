/**
 * Image attachment preparation (9 W9 B) — browser-side downscale BEFORE the
 * wire: a long-edge ≤1568px WebP/JPEG re-encode keeps turns at hundreds of KB
 * instead of megabytes. Animated GIFs cannot survive a canvas round-trip, so
 * small ones pass through untouched. The shared schema's 6 MB caps are the
 * backstop, not the design.
 */

type PromptImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface DraftAttachment {
  id: string;
  name: string;
  data: string;
  mimeType: PromptImageMime;
}

/** Error codes the page maps to i18n toasts. */
type ImageAttachError = 'too-large' | 'bad-type' | 'decode-failed';

export class ImageAttachError_ extends Error {
  constructor(
    public code: ImageAttachError,
    public name_: string,
  ) {
    super(code);
  }
}

const MAX_EDGE = 1568;
const QUALITY = 0.85;
/** Source caps: GIF passes through (no re-encode possible), so it is tighter. */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_GIF_BYTES = 2 * 1024 * 1024;

const ACCEPTED: readonly PromptImageMime[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** The `accept` string for the hidden file input. */

/** Wire caps mirrored from the shared schema (per-turn budget). */
export const MAX_IMAGES_PER_TURN = 4;
export const MAX_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;

function stripDataUrl(url: string): { data: string; mimeType: PromptImageMime } | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (match === null) return null;
  const mime = match[1]! as PromptImageMime;
  if (!ACCEPTED.includes(mime)) return null;
  return { data: match[2]!, mimeType: mime };
}

async function decode(
  file: File,
): Promise<{ width: number; height: number; draw: CanvasImageSource }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height, draw: bitmap };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight, draw: img };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Turn one picked/pasted/dropped file into a wire-ready attachment. Throws
 * `ImageAttachError_` with a stable code + the display name.
 */
export async function fileToAttachment(file: File): Promise<DraftAttachment> {
  const type = file.type as PromptImageMime;
  if (!ACCEPTED.includes(type)) throw new ImageAttachError_('bad-type', file.name);
  if (type === 'image/gif') {
    if (file.size > MAX_GIF_BYTES) throw new ImageAttachError_('too-large', file.name);
    const data = await readBase64(file);
    return { id: crypto.randomUUID(), name: file.name, data, mimeType: 'image/gif' };
  }
  if (file.size > MAX_SOURCE_BYTES) throw new ImageAttachError_('too-large', file.name);
  try {
    const { width, height, draw } = await decode(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('no 2d context');
    ctx.drawImage(draw, 0, 0, canvas.width, canvas.height);
    // Prefer WebP (Chrome/Edge/Firefox all encode it); fall back to JPEG.
    let encoded = stripDataUrl(canvas.toDataURL('image/webp', QUALITY));
    if (encoded === null) encoded = stripDataUrl(canvas.toDataURL('image/jpeg', QUALITY));
    if (encoded === null) throw new Error('encode failed');
    const original = await readBase64(file);
    // Never grow the payload: tiny/dense PNGs can beat the re-encode.
    const use =
      encoded.data.length <= original.length ? encoded : { data: original, mimeType: type };
    return { id: crypto.randomUUID(), name: file.name, data: use.data, mimeType: use.mimeType };
  } catch {
    throw new ImageAttachError_('decode-failed', file.name);
  }
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const stripped = stripDataUrl(String(reader.result ?? ''));
      stripped !== null ? resolve(stripped.data) : reject(new Error('not an image data URL'));
    });
    reader.addEventListener('error', () => reject(new Error('read failed')));
    reader.readAsDataURL(file);
  });
}

/** Total base64 bytes the draft's attachments would add to the turn. */
export function attachmentsBytes(attachments: readonly DraftAttachment[]): number {
  return attachments.reduce((sum, a) => sum + a.data.length, 0);
}
