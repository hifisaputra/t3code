import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  buildChatMarkdownImageCollection,
  extractMarkdownImageRefs,
  isExternalImageHref,
  openMarkdownImageLightbox,
} from "./chatMarkdownImages";
import { useImageLightboxStore } from "./imageLightboxStore";

describe("extractMarkdownImageRefs", () => {
  it("collects every image in a message, in source order", () => {
    const text = [
      "Here are the results:",
      "",
      "![first shot](.t3-images/one.png)",
      "![second shot](.t3-images/two.png)",
      "",
      "And a chart: ![chart](.t3-images/three.webp) inline.",
    ].join("\n");

    expect(extractMarkdownImageRefs(text)).toEqual([
      { href: ".t3-images/one.png", alt: "first shot" },
      { href: ".t3-images/two.png", alt: "second shot" },
      { href: ".t3-images/three.webp", alt: "chart" },
    ]);
  });

  it("keeps images that share a paragraph and tolerates empty alt text", () => {
    expect(extractMarkdownImageRefs("![](a.png) ![](b.png)")).toEqual([
      { href: "a.png", alt: "" },
      { href: "b.png", alt: "" },
    ]);
  });

  it("resolves each destination once even when repeated", () => {
    expect(extractMarkdownImageRefs("![a](x.png)\n![again](x.png)")).toEqual([
      { href: "x.png", alt: "a" },
    ]);
  });

  it("ignores plain links", () => {
    expect(extractMarkdownImageRefs("[not an image](x.png)")).toEqual([]);
  });
});

describe("isExternalImageHref", () => {
  it.each(["https://example.com/a.png", "HTTP://example.com/a.png"])("accepts %s", (href) => {
    expect(isExternalImageHref(href)).toBe(true);
  });

  it.each([".t3-images/a.png", "data:image/png;base64,AAAA", "file:///tmp/a.png"])(
    "rejects %s",
    (href) => {
      expect(isExternalImageHref(href)).toBe(false);
    },
  );
});

describe("openMarkdownImageLightbox", () => {
  beforeEach(() => {
    useImageLightboxStore.getState().close();
  });

  const collection = () =>
    buildChatMarkdownImageCollection(
      [
        { href: "one.png", name: "first", src: "https://host/assets/one" },
        { href: "pending.png", name: "pending", src: null },
        { href: "two.png", name: "second", src: "https://host/assets/two" },
      ],
      () => true,
      () => {},
    );

  it("opens the whole message's resolved images at the clicked one", () => {
    openMarkdownImageLightbox(collection(), "two.png");

    expect(useImageLightboxStore.getState().preview).toEqual({
      images: [
        { src: "https://host/assets/one", name: "first" },
        { src: "https://host/assets/two", name: "second" },
      ],
      index: 1,
    });
  });

  it("does nothing when the clicked image has not resolved", () => {
    openMarkdownImageLightbox(collection(), "pending.png");

    expect(useImageLightboxStore.getState().preview).toBeNull();
  });
});
