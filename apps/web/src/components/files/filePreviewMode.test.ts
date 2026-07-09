import { describe, expect, it } from "vite-plus/test";

import { imagePreviewMimeType, isImagePreviewFile } from "./filePreviewMode";

describe("isImagePreviewFile", () => {
  it("matches common image extensions case-insensitively", () => {
    for (const path of ["a.png", "dir/photo.JPG", "icon.svg", "x.webp", "y.avif", "z.gif"]) {
      expect(isImagePreviewFile(path)).toBe(true);
    }
  });

  it("ignores non-image files and query/hash suffixes", () => {
    expect(isImagePreviewFile("src/index.ts")).toBe(false);
    expect(isImagePreviewFile("README.md")).toBe(false);
    expect(isImagePreviewFile("noext")).toBe(false);
    expect(isImagePreviewFile("logo.png?v=2")).toBe(true);
  });
});

describe("imagePreviewMimeType", () => {
  it("maps extensions to MIME types (jpg and jpeg alias)", () => {
    expect(imagePreviewMimeType("a.png")).toBe("image/png");
    expect(imagePreviewMimeType("a.jpg")).toBe("image/jpeg");
    expect(imagePreviewMimeType("a.jpeg")).toBe("image/jpeg");
    expect(imagePreviewMimeType("a.svg")).toBe("image/svg+xml");
  });

  it("returns null for non-image paths", () => {
    expect(imagePreviewMimeType("a.txt")).toBe(null);
  });
});
