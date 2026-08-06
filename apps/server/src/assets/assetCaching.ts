import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/**
 * Asset URLs are signed and bound to a single file, so they are safe to keep in the
 * browser's private cache for the lifetime of a token bucket.
 */
export const ASSET_CACHE_CONTROL = "private, max-age=3600";

/** Cache validators for a served asset, matching what `HttpServerResponse.file` emits. */
export interface AssetValidators {
  /** Formatted `ETag` header value, including quotes. */
  readonly etag: string;
  /** Formatted `Last-Modified` header value, or null when the mtime is unavailable. */
  readonly lastModified: string | null;
  /** Modification time in milliseconds, or null when unavailable. */
  readonly lastModifiedMs: number | null;
}

/**
 * Derive validators from file metadata. The tag format mirrors Effect's metadata-based
 * ETag generator (`size-mtime`, both hex), so the value a client got from a `200` file
 * response compares equal to the one computed here on the next request.
 */
export function assetValidators(info: FileSystem.File.Info): AssetValidators {
  const mtime = Option.getOrNull(info.mtime);
  const tag = `${Number(info.size).toString(16)}-${mtime === null ? "0" : mtime.getTime().toString(16)}`;
  return {
    etag: `"${tag}"`,
    lastModified: mtime === null ? null : mtime.toUTCString(),
    lastModifiedMs: mtime === null ? null : mtime.getTime(),
  };
}

export function assetCacheHeaders(validators: AssetValidators): Record<string, string> {
  return {
    "Cache-Control": ASSET_CACHE_CONTROL,
    ETag: validators.etag,
    ...(validators.lastModified === null ? {} : { "Last-Modified": validators.lastModified }),
  };
}

/** Strip the weak marker and quotes so `W/"abc"`, `"abc"` and `abc` all compare equal. */
function normalizeEntityTag(value: string): string {
  const withoutWeakMarker = value.trim().replace(/^W\//i, "");
  return withoutWeakMarker.replace(/^"(.*)"$/s, "$1");
}

function matchesIfNoneMatch(headerValue: string, etag: string): boolean {
  if (headerValue.trim() === "*") return true;
  const candidate = normalizeEntityTag(etag);
  return headerValue
    .split(",")
    .some((entry) => entry.trim() !== "" && normalizeEntityTag(entry) === candidate);
}

function matchesIfModifiedSince(headerValue: string, lastModifiedMs: number): boolean {
  const since = Date.parse(headerValue);
  if (Number.isNaN(since)) return false;
  // `Last-Modified` has one-second resolution, so compare at that granularity.
  return Math.floor(lastModifiedMs / 1000) * 1000 <= since;
}

/**
 * Whether the client's cached copy is still current and the body can be skipped.
 * `If-None-Match` wins when present; `If-Modified-Since` is only consulted otherwise,
 * per RFC 9110.
 */
export function isAssetNotModified(
  headers: Readonly<Record<string, string | undefined>>,
  validators: AssetValidators,
): boolean {
  const ifNoneMatch = headers["if-none-match"];
  if (ifNoneMatch !== undefined && ifNoneMatch.trim() !== "") {
    return matchesIfNoneMatch(ifNoneMatch, validators.etag);
  }
  const ifModifiedSince = headers["if-modified-since"];
  if (
    ifModifiedSince === undefined ||
    ifModifiedSince.trim() === "" ||
    validators.lastModifiedMs === null
  ) {
    return false;
  }
  return matchesIfModifiedSince(ifModifiedSince, validators.lastModifiedMs);
}
