import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { assetEnvironment } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";

/**
 * A browser-loadable address for each of a task's e2e evidence files, its
 * screenshots or its recordings, in the order given. An entry is null when the
 * file cannot be shown inline (the copy on Linear needs a Linear login);
 * callers then link to the issue instead.
 *
 * Files recorded with their evidence path are served from the environment host
 * through signed asset URLs, which the asset atoms re-mint before the tokens
 * expire. Results from before the file was kept stay null.
 */
export function useAssistantEvidenceUrls(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  files: ReadonlyArray<{ readonly path?: string | undefined }>,
): ReadonlyArray<string | null> {
  const resources: Array<AssetResource> = [];
  const resourceIndex = files.map((file) => {
    if (file.path === undefined) return null;
    resources.push({ _tag: "media-file", threadId, path: file.path });
    return resources.length - 1;
  });
  // The family keys on the serialized request, so every render reads the same atom.
  const entries = useAtomValue(assetEnvironment.createUrls({ environmentId, resources }));
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  return resourceIndex.map((index) => {
    const entry = index === null ? undefined : entries[index];
    if (httpBaseUrl === null || entry === undefined || !AsyncResult.isSuccess(entry)) return null;
    return entry.value._tag === "resolved"
      ? resolveAssetUrl(httpBaseUrl, entry.value.relativeUrl)
      : null;
  });
}
