/**
 * Client-side image compression for composer attachments.
 *
 * A fullscreen screenshot is easily 8-15 MB as PNG. Encoded as base64 that
 * inflates ~33% and, sent inline in a single WebSocket RPC frame, reliably
 * fails to traverse remote/proxied deployments (large frame dropped with no
 * close event -> the send hangs with no error). It also blows the ~5 MB
 * localStorage quota the composer uses to persist drafts.
 *
 * Re-encoding to WebP with a capped longest edge typically shrinks such images
 * 20-50x, which keeps both the draft-persistence write and the send frame well
 * within limits. Anything we can't safely re-encode (SVG, animated GIF, already
 * small files) passes through untouched, and any failure falls back to the
 * original file so attachment behaviour is never worse than before.
 */

/** Longest-edge cap, in CSS pixels, applied before re-encoding. */
export const MAX_IMAGE_DIMENSION = 2000;

/** Skip compression below this size — small images gain nothing. */
export const COMPRESSION_MIN_BYTES = 256 * 1024;

const COMPRESSION_TARGET_TYPE = "image/webp";
const COMPRESSION_QUALITY = 0.85;

/**
 * Raster formats we can losslessly load into a canvas and safely re-encode.
 * SVG (vector, tiny), GIF (may be animated — canvas flattens it), and exotic
 * formats a given browser may decode inconsistently are intentionally excluded.
 */
const COMPRESSIBLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/bmp",
]);

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
};

function replaceExtension(name: string, extension: string): string {
  const trimmed = name.trim() || "image";
  const withoutExtension = trimmed.replace(/\.[^./\\]+$/, "");
  const base = withoutExtension.length > 0 ? withoutExtension : "image";
  return `${base}.${extension}`;
}

async function loadImageBitmap(file: File): Promise<{
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  readonly release: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.addEventListener("load", () => resolve(element), { once: true });
      element.addEventListener(
        "error",
        () => reject(new Error("Failed to decode image for compression.")),
        { once: true },
      );
      element.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/**
 * Returns a compressed copy of `file`, or the original file when compression is
 * skipped, unhelpful, or fails. Never throws.
 */
export async function compressComposerImage(file: File): Promise<File> {
  if (typeof document === "undefined") return file;
  if (!COMPRESSIBLE_IMAGE_TYPES.has(file.type)) return file;
  if (file.size < COMPRESSION_MIN_BYTES) return file;

  let handle: Awaited<ReturnType<typeof loadImageBitmap>> | null = null;
  try {
    handle = await loadImageBitmap(file);
    const { source, width, height } = handle;
    if (width === 0 || height === 0) return file;

    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(source, 0, 0, targetWidth, targetHeight);

    const blob = await canvasToBlob(canvas, COMPRESSION_TARGET_TYPE, COMPRESSION_QUALITY);
    // No blob, no size win, or the browser ignored the WebP request and handed
    // back something not smaller — keep the original either way.
    if (!blob || blob.size >= file.size) return file;

    const mimeType =
      blob.type && blob.type.startsWith("image/") ? blob.type : COMPRESSION_TARGET_TYPE;
    const extension = EXTENSION_BY_MIME_TYPE[mimeType] ?? "webp";
    return new File([blob], replaceExtension(file.name || "image", extension), {
      type: mimeType,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    handle?.release();
  }
}
