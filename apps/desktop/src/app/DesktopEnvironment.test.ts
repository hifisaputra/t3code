import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  // A distribution build must never share a path, id or scheme with the
  // official app, and T3CODE_HOME must still be able to point it anywhere.
  it.effect("renames every per-install artifact for a distribution build", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        { distributionId: Option.some("fork"), isPackaged: true },
        {},
      );

      assert.deepEqual(environment.distributionId, Option.some("fork"));
      assert.equal(environment.baseDirName, ".t3-fork");
      assert.equal(environment.baseDir, "/Users/alice/.t3-fork");
      assert.equal(environment.stateDir, "/Users/alice/.t3-fork/userdata");
      assert.equal(environment.desktopScheme, "t3code-fork");
      assert.equal(environment.appUserModelId, "com.t3tools.t3code.fork");
      assert.equal(environment.linuxDesktopEntryName, "com.t3tools.T3Code.Fork.desktop");
      assert.equal(environment.linuxWmClass, "t3code-fork");
      assert.equal(environment.displayName, "T3 Code Fork (Beta)");
      assert.equal(environment.branding.baseName, "T3 Code Fork");

      const development = yield* makeEnvironment(
        { distributionId: Option.some("fork") },
        { VITE_DEV_SERVER_URL: "http://localhost:5173", T3CODE_HOME: "/tmp/custom" },
      );
      assert.equal(development.baseDir, "/tmp/custom");
      assert.equal(development.desktopScheme, "t3code-fork-dev");
      assert.equal(development.appUserModelId, "com.t3tools.t3code.fork.dev");
      assert.equal(development.displayName, "T3 Code Fork (Dev)");
    }),
  );

  it.effect("keeps the official names without a distribution", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({ isPackaged: true }, {});
      assert.isTrue(Option.isNone(environment.distributionId));
      assert.equal(environment.baseDir, "/Users/alice/.t3");
      assert.equal(environment.desktopScheme, "t3code");
      assert.equal(environment.appUserModelId, "com.t3tools.t3code");
      assert.equal(environment.displayName, "T3 Code (Beta)");
    }),
  );

  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.t3/dev");
      assert.equal(production.stateDir, "/Users/alice/.t3/userdata");
    }),
  );
});
