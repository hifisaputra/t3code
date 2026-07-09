export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

function fileExtension(path: string): string {
  const name = path.split(/[?#]/, 1)[0] ?? "";
  const dotIndex = name.lastIndexOf(".");
  return dotIndex === -1 ? "" : name.slice(dotIndex + 1).toLowerCase();
}

export const isImagePreviewFile = (path: string): boolean =>
  fileExtension(path) in IMAGE_MIME_BY_EXTENSION;

/** MIME type for a browser-renderable image path, or null when it isn't a known image. */
export function imagePreviewMimeType(path: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[fileExtension(path)] ?? null;
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
