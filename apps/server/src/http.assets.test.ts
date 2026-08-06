import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpRouter } from "effect/unstable/http";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { assetRouteLayer } from "./http.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-route-test-",
});
const testLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeHttpServer.layerTest));

/** Serve a workspace image and hand back its URL plus a client bound to the test server. */
const serveImage = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-asset-route-" });
  const imagePath = path.join(root, "shot.png");
  yield* fileSystem.writeFile(imagePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

  yield* HttpRouter.serve(assetRouteLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(Layer.build);

  const issued = yield* issueAssetUrl({
    resource: { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: imagePath },
    workspaceRoot: root,
  });
  return { url: issued.relativeUrl, client: yield* HttpClient.HttpClient };
});

describe("asset route", () => {
  it.effect("serves the file with cache validators", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, client } = yield* serveImage();

        const response = yield* client.get(url);

        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("private, max-age=3600");
        expect(response.headers.etag).toBeDefined();
        expect(response.headers["last-modified"]).toBeDefined();
        expect((yield* response.arrayBuffer).byteLength).toBe(8);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("answers a revalidating request with 304 and no body", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, client } = yield* serveImage();
        const first = yield* client.get(url);
        const etag = first.headers.etag;
        yield* first.arrayBuffer;

        const revalidated = yield* client.get(url, { headers: { "if-none-match": etag } });

        expect(revalidated.status).toBe(304);
        expect(revalidated.headers.etag).toBe(etag);
        expect(revalidated.headers["cache-control"]).toBe("private, max-age=3600");
        expect((yield* revalidated.arrayBuffer).byteLength).toBe(0);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("revalidates by modification date when no tag is sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, client } = yield* serveImage();
        const first = yield* client.get(url);
        const lastModified = first.headers["last-modified"];
        yield* first.arrayBuffer;

        const revalidated = yield* client.get(url, {
          headers: { "if-modified-since": lastModified },
        });

        expect(revalidated.status).toBe(304);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("sends the body again once the file changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, client } = yield* serveImage();
        const first = yield* client.get(url);
        yield* first.arrayBuffer;

        const stale = yield* client.get(url, { headers: { "if-none-match": '"stale"' } });

        expect(stale.status).toBe(200);
        expect((yield* stale.arrayBuffer).byteLength).toBe(8);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
