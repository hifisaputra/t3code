import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState as RuntimeAssetUrlState,
  assetUrlStateFromResult,
  blockedAssetUrlState,
  EMPTY_ASSET_URL_ATOM,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AssetResource,
  type AssetCreateUrlEntry,
  type AssetCreateUrlResult,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type AssetUrlState = RuntimeAssetUrlState & { readonly waiting?: boolean };

type AssetUrlTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly resource: AssetResource };
};

const decodeRevisionedAssetUrlKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, AssetResource, Schema.NullOr(Schema.String)]),
);

const isSettled = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  !AsyncResult.isInitial(result) && !result.waiting;

/**
 * The URL is minted per resource and shared across revisions, so reading a
 * different revision (even an earlier one after a revert) re-mints it. An
 * in-flight mint is shared only on first read; after an edit the server must
 * re-read the file, so the re-mint waits for that mint to settle.
 */
export function makeRevisionedAssetUrlFamily(
  createUrl: (
    target: AssetUrlTarget,
  ) => Atom.Atom<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>,
) {
  // Outside the nodes: a node is dropped once unmounted, and the next read of
  // its revision must still see the revisions minted since. Never pruned on
  // purpose: pruning would forget the revision and re-mint on the next mount.
  // It holds one short entry per file shown, and goes with the registry.
  const mintedUnder = new WeakMap<AtomRegistry.AtomRegistry, Map<string, string | null>>();
  const family = Atom.family((key: string) => {
    const [environmentId, resource, revision] = decodeRevisionedAssetUrlKey(JSON.parse(key));
    const resourceKey = JSON.stringify([environmentId, resource]);
    const query = createUrl({ environmentId, input: { resource } });
    return Atom.transform(
      query,
      (get) => {
        let minted = mintedUnder.get(get.registry);
        if (minted === undefined) {
          minted = new Map();
          mintedUnder.set(get.registry, minted);
        }
        const firstRead = !minted.has(resourceKey);
        let pending = minted.get(resourceKey) !== revision;
        const current = get.once(query);
        if (pending && (firstRead || isSettled(current))) {
          pending = false;
          minted.set(resourceKey, revision);
          if (isSettled(current)) get.refresh(query);
        }
        get.subscribe(query, (value) => {
          get.setSelf(value);
          if (!pending || !isSettled(value)) return;
          pending = false;
          minted.set(resourceKey, revision);
          get.refresh(query);
        });
        return get.once(query);
      },
      { initialValueTarget: query },
      // No idle TTL: each mount rebuilds the node, so a revision read again after
      // another one is compared against the record instead of a cached node.
    ).pipe(Atom.setIdleTTL(0));
  });
  return (target: AssetUrlTarget & { readonly revision: string | null }) =>
    family(JSON.stringify([target.environmentId, target.input.resource, target.revision]));
}

const revisionedAssetUrl = makeRevisionedAssetUrlFamily(assetEnvironment.createUrl);

/**
 * Pass `revision` for a workspace file whose bytes can change under the same
 * path; each new revision gets a freshly minted URL.
 */
export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision?: string | null,
): AssetUrlState {
  const blocked = blockedAssetUrlState(resource, useFilesystemReadAccess(environmentId));
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    blocked !== null || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : revision === undefined
        ? assetEnvironment.createUrl({ environmentId, input: { resource } })
        : revisionedAssetUrl({ environmentId, input: { resource }, revision }),
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
