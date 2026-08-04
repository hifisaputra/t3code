import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { describe, expect, it } from "vite-plus/test";

import { IMAGE_GALLERY_MARKER, remarkImageGallery } from "./remarkImageGallery";

interface Node {
  type: string;
  url?: string;
  value?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: Node[];
}

const image = (url: string): Node => ({ type: "image", url });
const paragraph = (...children: Node[]): Node => ({ type: "paragraph", children });
const imageParagraph = (url: string): Node => paragraph(image(url));
const text = (value: string): Node => ({ type: "text", value });
const root = (...children: Node[]): Node => ({ type: "root", children });

function transform(tree: Node): Node {
  remarkImageGallery()(tree);
  return tree;
}

const galleryCount = (node: Node | undefined): unknown =>
  node?.data?.hProperties?.[IMAGE_GALLERY_MARKER];

describe("remarkImageGallery", () => {
  it("merges a run of image-only paragraphs into one marked paragraph", () => {
    const tree = transform(
      root(...Array.from({ length: 16 }, (_unused, index) => imageParagraph(`${index}.png`))),
    );

    expect(tree.children).toHaveLength(1);
    expect(galleryCount(tree.children?.[0])).toBe("16");
    expect(tree.children?.[0]?.children).toHaveLength(16);
  });

  it("groups images that already share one paragraph", () => {
    const tree = transform(root(paragraph(image("a.png"), text(" "), image("b.png"))));

    expect(galleryCount(tree.children?.[0])).toBe("2");
  });

  it("leaves a lone image as an ordinary paragraph", () => {
    const tree = transform(root(imageParagraph("only.png")));

    expect(galleryCount(tree.children?.[0])).toBeUndefined();
    expect(tree.children?.[0]?.children?.[0]?.type).toBe("image");
  });

  it("does not group a paragraph that carries prose alongside its image", () => {
    const tree = transform(
      root(imageParagraph("a.png"), paragraph(text("caption "), image("b.png"))),
    );

    expect(tree.children).toHaveLength(2);
    expect(galleryCount(tree.children?.[0])).toBeUndefined();
  });

  it("breaks the run where prose interrupts it", () => {
    const tree = transform(
      root(
        imageParagraph("a.png"),
        imageParagraph("b.png"),
        paragraph(text("Prose in between.")),
        imageParagraph("c.png"),
        imageParagraph("d.png"),
      ),
    );

    expect(tree.children).toHaveLength(3);
    expect(galleryCount(tree.children?.[0])).toBe("2");
    expect(tree.children?.[1]?.children?.[0]?.value).toBe("Prose in between.");
    expect(galleryCount(tree.children?.[2])).toBe("2");
  });

  it("groups image paragraphs nested inside a list item", () => {
    const item: Node = {
      type: "listItem",
      children: [imageParagraph("a.png"), imageParagraph("b.png")],
    };
    const tree = transform(root({ type: "list", children: [item] }));

    expect(galleryCount(tree.children?.[0]?.children?.[0]?.children?.[0])).toBe("2");
  });
});

describe("the gallery marker and the chat sanitizer", () => {
  // Mirrors the `p` entry in CHAT_MARKDOWN_SANITIZE_SCHEMA. Without it the sanitizer
  // drops the marker and every gallery silently falls back to a column of images.
  const schema = {
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      p: [...(defaultSchema.attributes?.p ?? []), IMAGE_GALLERY_MARKER],
    },
  };

  const markedParagraph = () => ({
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        properties: { [IMAGE_GALLERY_MARKER]: "3" },
        children: [],
      },
    ],
  });

  const sanitizeWith = (options: unknown, tree: unknown) => {
    const transformer = (
      rehypeSanitize as unknown as (options: unknown) => (tree: unknown) => unknown
    )(options);
    return transformer(tree) as { children: Array<{ properties?: Record<string, unknown> }> };
  };

  it("keeps the marker when the schema allows it on p", () => {
    const output = sanitizeWith(schema, markedParagraph());

    expect(output.children[0]?.properties?.[IMAGE_GALLERY_MARKER]).toBe("3");
  });

  it("is stripped by the default schema — the allowance is what makes it work", () => {
    const output = sanitizeWith(defaultSchema, markedParagraph());

    expect(output.children[0]?.properties?.[IMAGE_GALLERY_MARKER]).toBeUndefined();
  });
});
