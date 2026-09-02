import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure" }
  | { readonly _tag: "Success"; readonly url: string; readonly sourcePath?: string };

export function useAssetUrlState(
  environmentId: EnvironmentId,
  resource: AssetResource,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    assetEnvironment.createUrl({
      environmentId,
      input: { resource },
    }),
  );
  if (result._tag === "Failure") {
    return { _tag: "Failure" };
  }
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return { _tag: "Loading" };
  }
  const url = resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);
  return url === null
    ? { _tag: "Failure" }
    : {
        _tag: "Success",
        url,
        ...(result.value.sourcePath !== undefined ? { sourcePath: result.value.sourcePath } : {}),
      };
}

export function useAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  const result = useAssetUrlState(environmentId, resource);
  if (result._tag !== "Success") {
    return null;
  }
  return result.url;
}

/** Re-mints an exact-file capability after a file change or an explicit retry. */
export function useAssetUrlRefresh(
  environmentId: EnvironmentId,
  resource: AssetResource,
): () => Promise<void> {
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(async () => {
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  }, [environmentId, resource, refresh]);
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources,
    }),
  );
  return useMemo(
    () =>
      preparedConnection._tag === "None"
        ? resources.map(() => null)
        : results.map((result) =>
            AsyncResult.isSuccess(result) && result.value._tag === "resolved"
              ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
              : null,
          ),
    [preparedConnection, resources, results],
  );
}

/**
 * Stable identity for a resource. Written out per tag rather than via
 * `JSON.stringify` so a caller that builds the same resource with its keys in a
 * different order still lands on the same entry.
 */
export function assetResourceKey(resource: AssetResource): string {
  switch (resource._tag) {
    case "workspace-file":
    case "media-file": {
      return `${resource._tag}\u0000${resource.threadId}\u0000${resource.path}`;
    }
    case "attachment": {
      return `attachment\u0000${resource.attachmentId}`;
    }
    case "project-favicon": {
      return `project-favicon\u0000${resource.cwd}\u0000${resource.path ?? ""}`;
    }
  }
}

/** Batched states keyed by {@link assetResourceKey}, or null outside a provider. */
const AssetUrlBatchContext = createContext<ReadonlyMap<string, AssetUrlState> | null>(null);

/**
 * Resolve a set of resources as one request and share the results with every
 * descendant that renders one of them.
 *
 * A chat message can carry tens of images. Left to itself each `ChatMarkdownAssetImage`
 * mints its own URL, so the message costs one round trip per image and the last ones
 * appear long after the first — painful on a high-latency link. Wrapping the message in
 * this provider spends a single batched request on the whole set instead.
 *
 * Resources the provider does not cover still resolve on their own, so a reference-style
 * or raw-HTML image the scanner missed renders correctly, just unbatched.
 */
export function AssetUrlBatchProvider(props: {
  readonly environmentId: EnvironmentId;
  readonly resources: ReadonlyArray<AssetResource>;
  readonly children: ReactNode;
}) {
  const states = useAssetUrlStates(props.environmentId, props.resources);
  const batch = useMemo(() => {
    const entries = new Map<string, AssetUrlState>();
    props.resources.forEach((resource, index) => {
      const state = states[index];
      if (state) entries.set(assetResourceKey(resource), state);
    });
    return entries;
  }, [props.resources, states]);
  return <AssetUrlBatchContext value={batch}>{props.children}</AssetUrlBatchContext>;
}

/**
 * The batched state for a resource, or `undefined` when no enclosing provider covers it
 * — in which case the caller must fall back to {@link useAssetUrlState}. Reads context
 * only: it never issues a request of its own.
 */
export function useBatchedAssetUrlState(resource: AssetResource): AssetUrlState | undefined {
  const batch = useContext(AssetUrlBatchContext);
  return batch?.get(assetResourceKey(resource));
}

/** {@link useAssetUrls}, keeping the loading and failure states instead of flattening to a URL. */
export function useAssetUrlStates(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<AssetUrlState> {
  const preparedConnection = usePreparedConnection(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources,
    }),
  );
  return useMemo(
    () =>
      results.map((result): AssetUrlState => {
        if (AsyncResult.isFailure(result)) return { _tag: "Failure" };
        if (!AsyncResult.isSuccess(result)) return { _tag: "Loading" };
        if (result.value._tag === "failed") return { _tag: "Failure" };
        // A minted URL outlives the socket that minted it, so a dropped connection must
        // not blank an image that already resolved; only an unresolved one waits.
        if (preparedConnection._tag === "None") return { _tag: "Loading" };
        const url = resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);
        return url === null ? { _tag: "Failure" } : { _tag: "Success", url };
      }),
    [preparedConnection, results],
  );
}
