/**
 * Groups runs of image-only paragraphs into a single paragraph marked as a gallery, so a
 * message that attaches many images renders as a grid instead of a very long column.
 *
 * Runs after the chat sanitizer, so the marker needs no allowance in the shared sanitize
 * schema, and raw-HTML images group the same way markdown ones do.
 */

export const IMAGE_GALLERY_MARKER = "dataImageGallery";

/** Below this, images read better at full width than as grid cells. */
const MIN_GALLERY_IMAGES = 2;

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function isBlank(node: HastNode): boolean {
  return (
    (node.type === "text" && (node.value ?? "").trim().length === 0) ||
    (node.type === "element" && node.tagName === "br")
  );
}

/** A paragraph carrying only images (whitespace and line breaks between them are fine). */
function imagesOfParagraph(node: HastNode): HastNode[] | null {
  if (node.type !== "element" || node.tagName !== "p" || !node.children?.length) return null;
  const images: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "element" && child.tagName === "img") {
      images.push(child);
      continue;
    }
    if (!isBlank(child)) return null;
  }
  return images.length > 0 ? images : null;
}

export function rehypeImageGallery() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (!node.children) return;
      const next: HastNode[] = [];
      let run: HastNode[] = [];
      let runImages: HastNode[] = [];

      const flushRun = () => {
        if (runImages.length >= MIN_GALLERY_IMAGES) {
          for (const image of runImages) {
            // A grid cell is not a figure slot: a standalone image reserves a 16:9 box.
            if (image.properties) delete image.properties.dataStandalone;
          }
          next.push({
            type: "element",
            tagName: "p",
            properties: { [IMAGE_GALLERY_MARKER]: String(runImages.length) },
            children: runImages,
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
        // Whitespace between two image paragraphs keeps the run going.
        if (run.length > 0 && isBlank(child)) {
          run.push(child);
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
