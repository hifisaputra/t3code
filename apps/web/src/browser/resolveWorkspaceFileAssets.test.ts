import { ASSET_CREATE_URLS_MAX, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorkspaceFileAssets, type CreateAssetUrlsMutation } from "./openFileInPreview";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const httpBaseUrl = "https://host.example/";

/** Records every batch it is asked for, and resolves each path to a predictable URL. */
const recordingMutation = (options?: {
  readonly failPaths?: ReadonlySet<string>;
}): {
  readonly mutation: CreateAssetUrlsMutation<never>;
  readonly batches: Array<ReadonlyArray<string>>;
} => {
  const batches: Array<ReadonlyArray<string>> = [];
  const mutation: CreateAssetUrlsMutation<never> = async (input) => {
    const paths = input.input.resources.map((resource) =>
      resource._tag === "workspace-file" ? resource.path : "",
    );
    batches.push(paths);
    return AsyncResult.success({
      entries: paths.map((path) =>
        options?.failPaths?.has(path)
          ? ({ _tag: "failed", reason: "AssetWorkspaceAssetNotFoundError" } as const)
          : ({
              _tag: "resolved",
              relativeUrl: `/api/assets/token-${path}/shot.png`,
              expiresAt: 1_000,
            } as const),
      ),
    });
  };
  return { mutation, batches };
};

describe("resolveWorkspaceFileAssets", () => {
  it("resolves a whole message in a single request", async () => {
    const { mutation, batches } = recordingMutation();

    const result = await resolveWorkspaceFileAssets({
      threadRef,
      filePaths: ["/w/a.png", "/w/b.png", "/w/c.png"],
      httpBaseUrl,
      createAssetUrls: mutation,
    });

    expect(batches).toEqual([["/w/a.png", "/w/b.png", "/w/c.png"]]);
    expect(AsyncResult.isSuccess(result) && result.value).toEqual([
      { url: "https://host.example/api/assets/token-/w/a.png/shot.png", expiresAt: 1_000 },
      { url: "https://host.example/api/assets/token-/w/b.png/shot.png", expiresAt: 1_000 },
      { url: "https://host.example/api/assets/token-/w/c.png/shot.png", expiresAt: 1_000 },
    ]);
  });

  it("keeps one unusable file from taking down its neighbours", async () => {
    const { mutation } = recordingMutation({ failPaths: new Set(["/w/b.png"]) });

    const result = await resolveWorkspaceFileAssets({
      threadRef,
      filePaths: ["/w/a.png", "/w/b.png"],
      httpBaseUrl,
      createAssetUrls: mutation,
    });

    expect(
      AsyncResult.isSuccess(result) && result.value.map((asset) => asset?.url ?? null),
    ).toEqual(["https://host.example/api/assets/token-/w/a.png/shot.png", null]);
  });

  it("splits requests past the protocol's batch size", async () => {
    const { mutation, batches } = recordingMutation();
    const filePaths = Array.from(
      { length: ASSET_CREATE_URLS_MAX + 3 },
      (_value, index) => `/w/${index}.png`,
    );

    const result = await resolveWorkspaceFileAssets({
      threadRef,
      filePaths,
      httpBaseUrl,
      createAssetUrls: mutation,
    });

    expect(batches.map((batch) => batch.length)).toEqual([ASSET_CREATE_URLS_MAX, 3]);
    expect(AsyncResult.isSuccess(result) && result.value).toHaveLength(filePaths.length);
  });

  it("propagates a failed request instead of reporting empty images", async () => {
    const failure = Cause.fail(new Error("socket closed"));

    const result = await resolveWorkspaceFileAssets({
      threadRef,
      filePaths: ["/w/a.png"],
      httpBaseUrl,
      createAssetUrls: async () => AsyncResult.failure(failure),
    });

    expect(AsyncResult.isFailure(result)).toBe(true);
  });

  it("asks for nothing when there is nothing to resolve", async () => {
    const { mutation, batches } = recordingMutation();

    const result = await resolveWorkspaceFileAssets({
      threadRef,
      filePaths: [],
      httpBaseUrl,
      createAssetUrls: mutation,
    });

    expect(batches).toEqual([]);
    expect(AsyncResult.isSuccess(result) && result.value).toEqual([]);
  });
});
