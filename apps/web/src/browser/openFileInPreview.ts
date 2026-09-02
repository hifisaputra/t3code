import type {
  AssetCreateUrlResult,
  AssetCreateUrlsResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ASSET_CREATE_URLS_MAX } from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  applyPreviewServerSnapshot,
  isPreviewSupportedInRuntime,
  rememberPreviewUrl,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export class BrowserPreviewUnavailableError extends Data.TaggedError(
  "BrowserPreviewUnavailableError",
)<{
  readonly message: string;
}> {}

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

export async function openUrlInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, url: input.url },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    rememberPreviewUrl(input.threadRef, input.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

export type CreateAssetUrlMutation<AssetError> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly resource: AssetResource };
}) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;

/** An absolute asset URL together with the moment its signed token stops being accepted. */
export interface ResolvedFileAsset {
  readonly url: string;
  readonly expiresAt: number;
}

/**
 * Resolve a workspace file to an absolute, backend-served asset URL and the token's
 * expiry — callers that cache the URL need to know how long it stays usable.
 */
export async function resolveWorkspaceFileAsset<AssetError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: CreateAssetUrlMutation<AssetError>;
}): Promise<AtomCommandResult<ResolvedFileAsset, AssetError>> {
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: "workspace-file",
        threadId: input.threadRef.threadId,
        path: input.filePath,
      },
    },
  });
  if (assetResult._tag === "Failure") {
    return AsyncResult.failure(assetResult.cause);
  }
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    return AsyncResult.failure(
      Cause.die(new Error("The environment returned an invalid asset URL.")),
    );
  }
  return AsyncResult.success({ url: assetUrl, expiresAt: assetResult.value.expiresAt });
}

export type CreateAssetUrlsMutation<AssetError> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly resources: ReadonlyArray<AssetResource> };
}) => Promise<AtomCommandResult<AssetCreateUrlsResult, AssetError>>;

/**
 * Resolve many workspace files in one round trip — the shape a chat message needs, where
 * asking per image cost one request each and dominated the time to first paint on a
 * high-latency link. Returns one slot per requested path, in order; a file the server
 * could not mint a URL for comes back as `null` rather than failing its neighbours.
 * Requests beyond the protocol's batch size are split across as few calls as possible.
 */
export async function resolveWorkspaceFileAssets<AssetError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePaths: ReadonlyArray<string>;
  readonly httpBaseUrl: string;
  readonly createAssetUrls: CreateAssetUrlsMutation<AssetError>;
}): Promise<AtomCommandResult<ReadonlyArray<ResolvedFileAsset | null>, AssetError>> {
  const resolved: Array<ResolvedFileAsset | null> = [];
  for (let start = 0; start < input.filePaths.length; start += ASSET_CREATE_URLS_MAX) {
    const chunk = input.filePaths.slice(start, start + ASSET_CREATE_URLS_MAX);
    const batchResult = await input.createAssetUrls({
      environmentId: input.threadRef.environmentId,
      input: {
        resources: chunk.map((path) => ({
          _tag: "workspace-file" as const,
          threadId: input.threadRef.threadId,
          path,
        })),
      },
    });
    if (batchResult._tag === "Failure") {
      return AsyncResult.failure(batchResult.cause);
    }
    for (const [index] of chunk.entries()) {
      const entry = batchResult.value.entries[index];
      if (entry === undefined || entry._tag === "failed") {
        resolved.push(null);
        continue;
      }
      const assetUrl = resolveAssetUrl(input.httpBaseUrl, entry.relativeUrl);
      resolved.push(assetUrl === null ? null : { url: assetUrl, expiresAt: entry.expiresAt });
    }
  }
  return AsyncResult.success(resolved);
}

/** {@link resolveWorkspaceFileAsset} for callers that only need the URL. */
export async function resolveWorkspaceFileAssetUrl<AssetError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: CreateAssetUrlMutation<AssetError>;
}): Promise<AtomCommandResult<string, AssetError>> {
  return mapAtomCommandResult(await resolveWorkspaceFileAsset(input), (asset) => asset.url);
}

/**
 * Opens a browser document in the integrated browser. Inside the workspace the
 * page may load sibling assets; a file outside it is served on its own.
 */
export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<AtomCommandResult<void, AssetError | PreviewError | BrowserPreviewUnavailableError>> {
  if (!isPreviewSupportedInRuntime()) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  const insideWorkspace =
    mediaFileReference(input.filePath, input.workspaceRoot).relativePath !== undefined;
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: insideWorkspace ? "workspace-file" : "media-file",
        threadId: input.threadRef.threadId,
        path: input.filePath,
      },
    },
  });
  if (assetResult._tag === "Failure") {
    return AsyncResult.failure(assetResult.cause);
  }
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    return AsyncResult.failure(
      Cause.die(new Error("The environment returned an invalid asset URL.")),
    );
  }
  return openUrlInPreview({
    threadRef: input.threadRef,
    url: assetUrl,
    openPreview: input.openPreview,
  });
}
