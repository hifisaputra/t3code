import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  assetCacheHeaders,
  assetValidators,
  isAssetNotModified,
  type AssetValidators,
} from "./assetCaching.ts";

const dateAt = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
const shiftedBy = (date: Date, milliseconds: number) =>
  DateTime.toDateUtc(DateTime.add(DateTime.makeUnsafe(date), { milliseconds }));
const mtime = dateAt("2026-08-06T10:00:00.000Z");
const fileInfo = (overrides?: { readonly mtime?: Date | null; readonly size?: number }) =>
  ({
    size: overrides?.size ?? 4096,
    mtime: overrides?.mtime === null ? Option.none() : Option.some(overrides?.mtime ?? mtime),
  }) as unknown as Parameters<typeof assetValidators>[0];

describe("assetValidators", () => {
  it("derives the same tag Effect's file response emits", () => {
    expect(assetValidators(fileInfo())).toEqual({
      etag: `"1000-${mtime.getTime().toString(16)}"`,
      lastModified: mtime.toUTCString(),
      lastModifiedMs: mtime.getTime(),
    } satisfies AssetValidators);
  });

  it("falls back to a zero mtime component when the filesystem has none", () => {
    const validators = assetValidators(fileInfo({ mtime: null }));

    expect(validators.etag).toBe('"1000-0"');
    expect(validators.lastModified).toBeNull();
  });

  it("changes the tag when the file changes", () => {
    expect(assetValidators(fileInfo({ size: 8192 })).etag).not.toBe(
      assetValidators(fileInfo()).etag,
    );
    expect(assetValidators(fileInfo({ mtime: shiftedBy(mtime, 1000) })).etag).not.toBe(
      assetValidators(fileInfo()).etag,
    );
  });
});

describe("assetCacheHeaders", () => {
  it("carries the validators alongside the cache policy", () => {
    expect(assetCacheHeaders(assetValidators(fileInfo()))).toEqual({
      "Cache-Control": "private, max-age=3600",
      ETag: `"1000-${mtime.getTime().toString(16)}"`,
      "Last-Modified": mtime.toUTCString(),
    });
  });

  it("omits Last-Modified when the mtime is unknown", () => {
    expect(assetCacheHeaders(assetValidators(fileInfo({ mtime: null })))).not.toHaveProperty(
      "Last-Modified",
    );
  });
});

describe("isAssetNotModified", () => {
  const validators = assetValidators(fileInfo());

  it("matches a returned tag regardless of weakness", () => {
    for (const header of [validators.etag, `W/${validators.etag}`, "*"]) {
      expect(isAssetNotModified({ "if-none-match": header }, validators)).toBe(true);
    }
  });

  it("matches a tag inside a list", () => {
    expect(isAssetNotModified({ "if-none-match": `"other", ${validators.etag}` }, validators)).toBe(
      true,
    );
  });

  it("rejects a stale tag", () => {
    expect(isAssetNotModified({ "if-none-match": '"stale"' }, validators)).toBe(false);
  });

  it("ignores If-Modified-Since when a tag was sent", () => {
    expect(
      isAssetNotModified(
        { "if-none-match": '"stale"', "if-modified-since": mtime.toUTCString() },
        validators,
      ),
    ).toBe(false);
  });

  it("falls back to the modification date when no tag was sent", () => {
    expect(isAssetNotModified({ "if-modified-since": mtime.toUTCString() }, validators)).toBe(true);
    expect(
      isAssetNotModified(
        { "if-modified-since": shiftedBy(mtime, -1000).toUTCString() },
        validators,
      ),
    ).toBe(false);
  });

  it("ignores an unparsable or empty date", () => {
    expect(isAssetNotModified({ "if-modified-since": "not a date" }, validators)).toBe(false);
    expect(isAssetNotModified({ "if-modified-since": "" }, validators)).toBe(false);
  });

  it("revalidates when the client sent no validators", () => {
    expect(isAssetNotModified({}, validators)).toBe(false);
  });
});
