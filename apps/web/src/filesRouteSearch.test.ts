import { describe, expect, it } from "vite-plus/test";

import { parseFilesRouteSearch, stripFilesSearchParams } from "./filesRouteSearch";

describe("parseFilesRouteSearch", () => {
  it("parses valid files search values", () => {
    const parsed = parseFilesRouteSearch({
      files: "1",
      filePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      files: "1",
      filePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean files toggles as open", () => {
    expect(parseFilesRouteSearch({ files: 1, filePath: "a.ts" })).toEqual({
      files: "1",
      filePath: "a.ts",
    });
    expect(parseFilesRouteSearch({ files: true, filePath: "a.ts" })).toEqual({
      files: "1",
      filePath: "a.ts",
    });
  });

  it("drops the file value when files is closed", () => {
    expect(parseFilesRouteSearch({ files: "0", filePath: "src/app.ts" })).toEqual({});
  });

  it("normalizes whitespace-only file values", () => {
    expect(parseFilesRouteSearch({ files: "1", filePath: "   " })).toEqual({ files: "1" });
  });
});

describe("stripFilesSearchParams", () => {
  it("removes files and filePath while keeping other params", () => {
    expect(stripFilesSearchParams({ files: "1", filePath: "src/app.ts", diff: "1" })).toEqual({
      diff: "1",
    });
  });
});
