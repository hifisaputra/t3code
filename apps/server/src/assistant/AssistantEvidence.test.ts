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

    const read = yield* evidence.read("task-1", path.join(directory, "page.png"), "screenshot");
    assert.equal(read.contentType, "image/png");
    assert.deepEqual([...read.bytes], [137, 80]);
    // The resolved file is what a client is later served, so it is the real path inside the folder.
    assert.equal(read.path, yield* fs.realPath(path.join(directory, "page.png")));
    assert.equal((yield* evidence.read("task-1", "page.png", "screenshot")).fileName, "page.png");
    for (const file of [
      path.join(other, "theirs.png"),
      path.join(directory, "..", "task-2", "theirs.png"),
      path.join(directory, "link.png"),
      path.join(directory, "notes.txt"),
      path.join(directory, "missing.png"),
    ])
      assert.isTrue(
        yield* evidence.read("task-1", file, "screenshot").pipe(Effect.isFailure),
        file,
      );
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("reads MP4 and WebM recordings up to Linear's 10 MB upload limit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const evidence = yield* Evidence.AssistantEvidence;
    const directory = yield* evidence.directory("task-1");
    const other = yield* evidence.directory("task-2");
    yield* fs.writeFile(path.join(directory, "flow.webm"), new Uint8Array([26, 69]));
    yield* fs.writeFile(path.join(directory, "flow.MP4"), new Uint8Array([0, 0]));
    yield* fs.writeFile(path.join(directory, "empty.webm"), new Uint8Array());
    yield* fs.writeFile(path.join(directory, "long.webm"), new Uint8Array(10 * 1024 * 1024 + 1));
    yield* fs.writeFile(path.join(directory, "page.png"), new Uint8Array([137, 80]));
    yield* fs.writeFile(path.join(other, "theirs.webm"), new Uint8Array([26, 69]));

    const webm = yield* evidence.read("task-1", path.join(directory, "flow.webm"), "video");
    assert.equal(webm.contentType, "video/webm");
    assert.deepEqual([...webm.bytes], [26, 69]);
    assert.equal((yield* evidence.read("task-1", "flow.MP4", "video")).contentType, "video/mp4");
    // Each kind takes only its own files.
    assert.isTrue(yield* evidence.read("task-1", "page.png", "video").pipe(Effect.isFailure));
    assert.isTrue(yield* evidence.read("task-1", "flow.webm", "screenshot").pipe(Effect.isFailure));
    assert.isTrue(yield* evidence.read("task-1", "empty.webm", "video").pipe(Effect.isFailure));
    assert.isTrue(
      yield* evidence
        .read("task-1", path.join(other, "theirs.webm"), "video")
        .pipe(Effect.isFailure),
    );
    const tooLong = yield* evidence.read("task-1", "long.webm", "video").pipe(Effect.flip);
    assert.include(tooLong.detail, "one per criterion");
    assert.include(tooLong.detail, "10 MB");
  }).pipe(Effect.provide(layer), Effect.scoped),
);
