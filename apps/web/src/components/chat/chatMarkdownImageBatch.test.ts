import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectChatMarkdownImageResources } from "./chatMarkdownImageBatch";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

function collect(text: string, imageBaseDir: string | undefined = "/workspace/project") {
  return collectChatMarkdownImageResources({ text, imageBaseDir, threadRef });
}

function paths(text: string, imageBaseDir?: string) {
  return collect(text, imageBaseDir).map((resource) =>
    resource._tag === "media-file" ? resource.path : resource._tag,
  );
}

describe("collectChatMarkdownImageResources", () => {
  it("collects every workspace image in source order", () => {
    expect(
      paths("![one](.t3-images/a.png)\n\n![two](.t3-images/b.png)\n\n![three](docs/c.png)"),
    ).toEqual([
      "/workspace/project/.t3-images/a.png",
      "/workspace/project/.t3-images/b.png",
      "/workspace/project/docs/c.png",
    ]);
  });

  it("resolves a message carrying tens of images into one set", () => {
    const text = Array.from({ length: 40 }, (_, index) => `![shot](.t3-images/${index}.png)`).join(
      "\n\n",
    );
    expect(collect(text)).toHaveLength(40);
  });

  it("de-duplicates a path repeated in the same message", () => {
    expect(paths("![a](.t3-images/a.png)\n\n![again](.t3-images/a.png)")).toEqual([
      "/workspace/project/.t3-images/a.png",
    ]);
  });

  it("skips sources that render without a signed URL", () => {
    expect(
      paths(
        [
          "![remote](https://example.test/a.png)",
          "![data](data:image/png;base64,AAAA)",
          "![blob](blob:https://example.test/abc)",
          "![protocol relative](//example.test/a.png)",
        ].join("\n\n"),
      ),
    ).toEqual([]);
  });

  it("ignores images inside fenced and inline code", () => {
    const text = [
      "Here is how you embed one:",
      "",
      "```markdown",
      "![example](.t3-images/example.png)",
      "```",
      "",
      "Inline too: `![inline](.t3-images/inline.png)`",
      "",
      "![real](.t3-images/real.png)",
    ].join("\n");
    expect(paths(text)).toEqual(["/workspace/project/.t3-images/real.png"]);
  });

  it("reads an angle-bracket destination and drops a title", () => {
    expect(
      paths('![spaced](<.t3-images/a b.png>)\n\n![titled](.t3-images/c.png "A caption")'),
    ).toEqual(["/workspace/project/.t3-images/a b.png", "/workspace/project/.t3-images/c.png"]);
  });

  it("collects an absolute path that lies outside the workspace", () => {
    expect(paths("![outside](/etc/hosts.png)")).toEqual(["/etc/hosts.png"]);
  });

  it("resolves relative paths against the image base directory", () => {
    expect(paths("![beside](images/diagram.png)", "/workspace/project/docs")).toEqual([
      "/workspace/project/docs/images/diagram.png",
    ]);
  });

  it("collects nothing without a thread to mint against", () => {
    expect(
      collectChatMarkdownImageResources({
        text: "![one](.t3-images/a.png)",
        imageBaseDir: "/workspace/project",
        threadRef: undefined,
      }),
    ).toEqual([]);
  });

  it("collects nothing when a relative path has no base directory to anchor it", () => {
    expect(
      collectChatMarkdownImageResources({
        text: "![one](.t3-images/a.png)",
        imageBaseDir: undefined,
        threadRef,
      }),
    ).toEqual([]);
  });

  it("collects nothing from a message with no images", () => {
    expect(paths("Just prose, and a [link](docs/README.md).")).toEqual([]);
  });
});
