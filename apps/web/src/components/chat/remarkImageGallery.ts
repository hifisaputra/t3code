/**
 * Groups runs of image-only paragraphs into a single paragraph marked as a gallery, so
 * a message that attaches many images renders as a grid instead of a very long vertical
 * list. Markers (rather than a custom node type) keep the output inside the sanitizer's
 * allowlist — see `dataImageGallery` in `CHAT_MARKDOWN_SANITIZE_SCHEMA`.
 */

export const IMAGE_GALLERY_MARKER = "dataImageGallery";

/** Below this, images read better at full width than as grid cells. */
const MIN_GALLERY_IMAGES = 2;

interface MarkdownNode {
  type?: string;
  value?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: MarkdownNode[];
}

function isBlank(node: MarkdownNode): boolean {
  return (node.type === "text" && (node.value ?? "").trim().length === 0) || node.type === "break";
}

/** A paragraph carrying only images (whitespace and soft breaks between them are fine). */
function imagesOfParagraph(node: MarkdownNode): MarkdownNode[] | null {
  if (node.type !== "paragraph" || !node.children || node.children.length === 0) return null;
  const images: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "image") {
      images.push(child);
      continue;
    }
    if (!isBlank(child)) return null;
  }
  return images.length > 0 ? images : null;
}

export function remarkImageGallery() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      const next: MarkdownNode[] = [];
      let run: MarkdownNode[] = [];
      let runImages: MarkdownNode[] = [];

      const flushRun = () => {
        if (runImages.length >= MIN_GALLERY_IMAGES) {
          next.push({
            type: "paragraph",
            children: runImages,
            data: { hProperties: { [IMAGE_GALLERY_MARKER]: String(runImages.length) } },
          });
        } else {
          next.push(...run);
        }
        run = [];
        runImages = [];
      };

      for (const child of node.children) {
        const images = imagesOfParagraph(child);
        if (images) {
          run.push(child);
          runImages.push(...images);
          continue;
        }
        flushRun();
        visit(child);
        next.push(child);
      }
      flushRun();
      node.children = next;
    };

    visit(tree);
  };
}
