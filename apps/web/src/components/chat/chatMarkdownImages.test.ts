import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  buildChatMarkdownImageCollection,
  extractMarkdownImageRefs,
  isExternalImageHref,
  openMarkdownImageLightbox,
  resolveChatMarkdownImageSrc,
  retainResolvedImageSrc,
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

describe("retainResolvedImageSrc", () => {
  it("keeps resolved URLs across a reconnect so the browser cache still applies", () => {
    const current = new Map([
      ["one.png", "https://host/assets/one"],
      ["two.png", null],
    ]);

    expect([...retainResolvedImageSrc(current)]).toEqual([["one.png", "https://host/assets/one"]]);
  });

  it("returns the same map when there is no failure to retry", () => {
    const current = new Map([["one.png", "https://host/assets/one"]]);

    expect(retainResolvedImageSrc(current)).toBe(current);
  });
});

describe("openMarkdownImageLightbox", () => {
  beforeEach(() => {
    useImageLightboxStore.getState().close();
  });

  const collection = () =>
    buildChatMarkdownImageCollection({
      entries: [
        { href: "one.png", name: "first", src: "https://host/assets/one" },
        { href: "pending.png", name: "pending", src: null },
        { href: "two.png", name: "second", src: "https://host/assets/two" },
      ],
      isSettled: () => true,
      request: () => {},
      retry: () => {},
    });

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

describe("resolveChatMarkdownImageSrc", () => {
  const resolvedByHref = new Map<string, string | null>([
    ["shot.png", "https://host/assets/shot?token=abc"],
    ["missing.png", null],
  ]);

  it("keeps showing a resolved workspace image — the caller must not gate this on the connection", () => {
    // Regression: while the socket was down the src was forced to null, so every image
    // on screen fell back to its alt text and re-downloaded once the socket returned.
    expect(
      resolveChatMarkdownImageSrc({ href: "shot.png", isWorkspaceImage: true, resolvedByHref }),
    ).toBe("https://host/assets/shot?token=abc");
  });

  it("has no src for a workspace image the batch has not resolved", () => {
    expect(
      resolveChatMarkdownImageSrc({ href: "pending.png", isWorkspaceImage: true, resolvedByHref }),
    ).toBeNull();
    expect(
      resolveChatMarkdownImageSrc({ href: "missing.png", isWorkspaceImage: true, resolvedByHref }),
    ).toBeNull();
  });

  it("renders an http(s) image straight from its own URL", () => {
    expect(
      resolveChatMarkdownImageSrc({
        href: "https://example.com/a.png",
        isWorkspaceImage: false,
        resolvedByHref,
      }),
    ).toBe("https://example.com/a.png");
  });

  it("has no src for a non-workspace path that is not a URL", () => {
    expect(
      resolveChatMarkdownImageSrc({ href: "./local.png", isWorkspaceImage: false, resolvedByHref }),
    ).toBeNull();
  });
});
