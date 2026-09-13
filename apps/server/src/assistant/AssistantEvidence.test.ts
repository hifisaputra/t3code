import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as Evidence from "./AssistantEvidence.ts";

const layer = Evidence.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-evidence-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("reads screenshots only from the issue's own evidence folder", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const evidence = yield* Evidence.AssistantEvidence;
    const directory = yield* evidence.directory("task-1");
    const other = yield* evidence.directory("task-2");
    yield* fs.writeFile(path.join(directory, "page.png"), new Uint8Array([137, 80]));
    yield* fs.writeFile(path.join(other, "theirs.png"), new Uint8Array([137, 80]));
    yield* fs.writeFileString(path.join(directory, "notes.txt"), "not an image");
    yield* fs.symlink(path.join(other, "theirs.png"), path.join(directory, "link.png"));

    const read = yield* evidence.read("task-1", path.join(directory, "page.png"));
    assert.equal(read.contentType, "image/png");
    assert.deepEqual([...read.bytes], [137, 80]);
    assert.equal((yield* evidence.read("task-1", "page.png")).fileName, "page.png");
    for (const file of [
      path.join(other, "theirs.png"),
      path.join(directory, "..", "task-2", "theirs.png"),
      path.join(directory, "link.png"),
      path.join(directory, "notes.txt"),
      path.join(directory, "missing.png"),
    ])
      assert.isTrue(yield* evidence.read("task-1", file).pipe(Effect.isFailure), file);
  }).pipe(Effect.provide(layer), Effect.scoped),
);
