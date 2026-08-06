import {
  ASSET_CREATE_URLS_MAX,
  AssetResource,
  type AssetCreateUrlEntry,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, AsyncResult } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const ASSET_URL_REFRESH_INTERVAL_MS = 30 * 60_000;
const ASSET_URL_STALE_TIME_MS = 5 * 60_000;
const ASSET_URL_IDLE_TTL_MS = 60 * 60_000;

export class InvalidAssetCollectionKeyError extends Schema.TaggedErrorClass<InvalidAssetCollectionKeyError>()(
  "InvalidAssetCollectionKeyError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid asset collection atom key: ${JSON.stringify(this.key)}.`;
  }
}

const decodeAssetCollectionKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.Array(AssetResource)]),
);

export function parseAssetCollectionKey(
  key: string,
): readonly [EnvironmentId, ReadonlyArray<AssetResource>] {
  try {
    return decodeAssetCollectionKey(JSON.parse(key));
  } catch (cause) {
    throw new InvalidAssetCollectionKeyError({ key, cause });
  }
}

export function resolveAssetUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    return new URL(relativeUrl, httpBaseUrl).toString();
  } catch {
    return null;
  }
}

/** Split a request into batches the protocol accepts; one request each, not one per resource. */
export function chunkAssetResources(
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<ReadonlyArray<AssetResource>> {
  const chunks: Array<ReadonlyArray<AssetResource>> = [];
  for (let index = 0; index < resources.length; index += ASSET_CREATE_URLS_MAX) {
    chunks.push(resources.slice(index, index + ASSET_CREATE_URLS_MAX));
  }
  return chunks;
}

export function createAssetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const createUrl = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:assets:create-url",
    tag: WS_METHODS.assetsCreateUrl,
    staleTimeMs: ASSET_URL_STALE_TIME_MS,
    idleTtlMs: ASSET_URL_IDLE_TTL_MS,
    refreshIntervalMs: ASSET_URL_REFRESH_INTERVAL_MS,
  });
  /**
   * Mint a whole set of URLs in one round trip. Resolving images one request at a time is
   * what made an image-heavy thread crawl on a high-latency link, so anything that knows
   * its full set up front — a chat message, an attachment row — should ask through here.
   */
  const createUrlBatch = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:assets:create-urls",
    tag: WS_METHODS.assetsCreateUrls,
    staleTimeMs: ASSET_URL_STALE_TIME_MS,
    idleTtlMs: ASSET_URL_IDLE_TTL_MS,
    refreshIntervalMs: ASSET_URL_REFRESH_INTERVAL_MS,
  });
  const createUrlsFamily = Atom.family((key: string) => {
    const [environmentId, resources] = parseAssetCollectionKey(key);
    const chunks = chunkAssetResources(resources);
    type Entry = AsyncResult.AsyncResult<AssetCreateUrlEntry, unknown>;
    return Atom.make(
      (get): ReadonlyArray<Entry> =>
        chunks.flatMap((chunk): ReadonlyArray<Entry> => {
          const batch = get(createUrlBatch({ environmentId, input: { resources: chunk } }));
          if (AsyncResult.isFailure(batch)) {
            // Every resource in the chunk shares the batch's failure.
            return chunk.map(() => AsyncResult.failure<AssetCreateUrlEntry, unknown>(batch.cause));
          }
          if (!AsyncResult.isSuccess(batch)) {
            return chunk.map(() => AsyncResult.initial<AssetCreateUrlEntry, unknown>(true));
          }
          // The server answers in request order, but never trust a short reply to line up.
          return chunk.map((_resource, index) => {
            const entry = batch.value.entries[index];
            return entry === undefined
              ? AsyncResult.initial<AssetCreateUrlEntry, unknown>(true)
              : AsyncResult.success<AssetCreateUrlEntry, unknown>(entry);
          });
        }),
    ).pipe(
      Atom.setIdleTTL(ASSET_URL_IDLE_TTL_MS),
      Atom.withLabel(`environment-data:assets:create-urls:${key}`),
    );
  });

  return {
    createUrl,
    createUrlBatch,
    createUrls: (target: {
      readonly environmentId: EnvironmentId;
      readonly resources: ReadonlyArray<AssetResource>;
    }) => createUrlsFamily(JSON.stringify([target.environmentId, target.resources])),
  };
}
