import { describe, expect, it } from "vite-plus/test";

import { IMAGE_GALLERY_MARKER, rehypeImageGallery } from "./rehypeImageGallery";

interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

const image = (src: string, properties: Record<string, unknown> = {}): Node => ({
  type: "element",
  tagName: "img",
  properties: { src, ...properties },
  children: [],
});
const paragraph = (...children: Node[]): Node => ({
  type: "element",
  tagName: "p",
  properties: {},
  children,
});
const imageParagraph = (src: string): Node => paragraph(image(src));
const text = (value: string): Node => ({ type: "text", value });
const root = (...children: Node[]): Node => ({ type: "root", children });

function transform(tree: Node): Node {
  rehypeImageGallery()(tree);
  return tree;
}

const galleryCount = (node: Node | undefined): unknown => node?.properties?.[IMAGE_GALLERY_MARKER];

describe("rehypeImageGallery", () => {
  it("merges a run of image-only paragraphs, and the newlines between them, into one", () => {
    const tree = transform(
      root(
        ...Array.from({ length: 16 }, (_unused, index) => [
          imageParagraph(`${index}.png`),
          text("\n"),
        ]).flat(),
      ),
    );

    expect(tree.children).toHaveLength(1);
    expect(galleryCount(tree.children?.[0])).toBe("16");
    expect(tree.children?.[0]?.children).toHaveLength(16);
  });

  it("groups images that already share one paragraph", () => {
    const tree = transform(
      root(paragraph(image("a.png"), { type: "element", tagName: "br" }, image("b.png"))),
    );

    expect(galleryCount(tree.children?.[0])).toBe("2");
  });

  it("drops the standalone slot from images that become grid cells", () => {
    const tree = transform(
      root(
        paragraph(image("a.png", { dataStandalone: true })),
        paragraph(image("b.png", { dataStandalone: true })),
      ),
    );

    expect(tree.children?.[0]?.children?.[0]?.properties?.dataStandalone).toBeUndefined();
  });

  it("leaves a lone image as an ordinary paragraph", () => {
    const tree = transform(root(imageParagraph("only.png"), text("\n")));

    expect(tree.children).toHaveLength(2);
    expect(galleryCount(tree.children?.[0])).toBeUndefined();
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
      type: "element",
      tagName: "li",
      children: [imageParagraph("a.png"), imageParagraph("b.png")],
    };
    const tree = transform(root({ type: "element", tagName: "ul", children: [item] }));

    expect(galleryCount(tree.children?.[0]?.children?.[0]?.children?.[0])).toBe("2");
  });
});
