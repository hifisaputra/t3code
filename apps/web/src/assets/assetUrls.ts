import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState as RuntimeAssetUrlState,
  assetUrlStateFromResult,
  blockedAssetUrlState,
  EMPTY_ASSET_URL_ATOM,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetCreateUrlEntry, AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type AssetUrlState = RuntimeAssetUrlState & { readonly waiting?: boolean };

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const blocked = blockedAssetUrlState(resource, useFilesystemReadAccess(environmentId));
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    blocked !== null || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  if (blocked !== null) return blocked;
  return {
    ...assetUrlStateFromResult(
      result,
      preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
    ),
    ...(result.waiting ? { waiting: true } : {}),
  };
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  };
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  return useAssetUrlStates(environmentId, resources).map((state) =>
    state._tag === "Success" ? state.url : null,
  );
}

/**
 * {@link useAssetUrls}, keeping the loading and failure states. Every resource the
 * connection may read is minted in one batched `assets.createUrls` request (split only at
 * the protocol's batch limit) instead of one round trip per resource.
 */
export function useAssetUrlStates(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<AssetUrlState> {
  const preparedConnection = usePreparedConnection(environmentId);
  const fileAccess = useFilesystemReadAccess(environmentId);
  const allowedResources = fileAccess.canReadFiles
    ? resources
    : resources.filter((resource) => blockedAssetUrlState(resource, fileAccess) === null);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: allowedResources,
    }),
  );
  const states: Array<AssetUrlState> = [];
  let resultIndex = 0;
  for (const resource of resources) {
    const blocked = blockedAssetUrlState(resource, fileAccess);
    if (blocked !== null) {
      states.push(blocked);
      continue;
    }
    const result = results[resultIndex];
    resultIndex += 1;
    states.push(assetUrlStateFromEntry(result, preparedConnection));
  }
  return states;
}

function assetUrlStateFromEntry(
  result: AsyncResult.AsyncResult<AssetCreateUrlEntry, unknown> | undefined,
  preparedConnection: ReturnType<typeof usePreparedConnection>,
): AssetUrlState {
  if (result === undefined || !AsyncResult.isSuccess(result)) {
    return result !== undefined && AsyncResult.isFailure(result)
      ? { _tag: "Failure" }
      : { _tag: "Loading" };
  }
  const entry = result.value;
  if (entry._tag === "failed") return { _tag: "Failure" };
  // A minted URL outlives the socket that minted it, but resolving it needs the
  // connection's origin; until that is back the image waits rather than failing.
  if (preparedConnection._tag === "None") return { _tag: "Loading" };
  const url = resolveAssetUrl(preparedConnection.value.httpBaseUrl, entry.relativeUrl);
  if (url === null) return { _tag: "Failure" };
  return {
    _tag: "Success",
    url,
    expiresAt: entry.expiresAt,
    ...(entry.sourcePath !== undefined ? { sourcePath: entry.sourcePath } : {}),
    ...(entry.imageDimensions !== undefined ? { imageDimensions: entry.imageDimensions } : {}),
  };
}
