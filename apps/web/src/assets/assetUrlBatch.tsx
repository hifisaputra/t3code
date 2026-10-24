import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { createContext, use, type ReactNode } from "react";

import { type AssetUrlState, useAssetUrlStates } from "./assetUrls";

/**
 * Stable identity for a resource. Written out per tag rather than via
 * `JSON.stringify(resource)` so a caller that builds the same resource with its
 * keys in a different order still lands on the same entry.
 */
function assetResourceKey(resource: AssetResource): string {
  switch (resource._tag) {
    case "workspace-file":
    case "media-file":
      return JSON.stringify([resource._tag, resource.threadId, resource.path]);
    case "attachment":
      // Name, type and disposition are baked into the signed URL, so two requests
      // that differ only there are genuinely different resources.
      return JSON.stringify([
        resource._tag,
        resource.attachmentId,
        resource.fileName ?? "",
        resource.mimeType ?? "",
        resource.disposition ?? "",
        resource.renderIntent ?? "",
      ]);
    case "draft-workspace-file":
      return JSON.stringify([resource._tag, resource.cwd, resource.path]);
    case "tool-output-image":
      return JSON.stringify([resource._tag, resource.threadId, resource.itemId, resource.index]);
    case "project-favicon":
      return JSON.stringify([resource._tag, resource.cwd, resource.path ?? ""]);
    case "native-app-icon": {
      const app = resource.app;
      return JSON.stringify([
        resource._tag,
        app._tag,
        app._tag === "app-id" ? app.appId : app.displayName,
      ]);
    }
    case "github-media":
      return JSON.stringify([resource._tag, resource.cwd, resource.url]);
  }
}

/** Batched states keyed by {@link assetResourceKey}, or null outside a provider. */
const AssetUrlBatchContext = createContext<ReadonlyMap<string, AssetUrlState> | null>(null);

/**
 * Resolve a set of resources as one request and share the results with every
 * descendant that renders one of them.
 *
 * A chat message can carry tens of images. Left to itself each image mints its own
 * URL, so the message costs one round trip per image and the last ones appear long
 * after the first, which is painful on a high-latency link. Wrapping the message in
 * this provider spends a single batched request on the whole set instead.
 *
 * Resources the provider does not cover still resolve on their own, so a
 * reference-style or raw-HTML image the scanner missed renders correctly, just
 * unbatched.
 */
export function AssetUrlBatchProvider(props: {
  readonly environmentId: EnvironmentId;
  readonly resources: ReadonlyArray<AssetResource>;
  readonly children: ReactNode;
}) {
  const states = useAssetUrlStates(props.environmentId, props.resources);
  const batch = new Map<string, AssetUrlState>();
  props.resources.forEach((resource, index) => {
    const state = states[index];
    if (state) batch.set(assetResourceKey(resource), state);
  });
  return <AssetUrlBatchContext value={batch}>{props.children}</AssetUrlBatchContext>;
}

/**
 * The batched state for a resource, or `undefined` when no enclosing provider
 * covers it, in which case the caller resolves it on its own. Reads context only:
 * it never issues a request of its own.
 */
export function useBatchedAssetUrlState(resource: AssetResource): AssetUrlState | undefined {
  return use(AssetUrlBatchContext)?.get(assetResourceKey(resource));
}
