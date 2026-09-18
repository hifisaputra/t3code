// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { layerTest as codexResetCreditLayerTest } from "../Layers/codexResetCredit.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  createProviderVersionAdvisory,
  ProviderVersionCache,
  resolveLatestProviderVersion,
} from "../providerMaintenance.ts";
import { CodexDriver } from "./CodexDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-codex-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(codexResetCreditLayerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Codex must not make an HTTP request")),
    ),
  ),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Codex must not spawn a process"),
);

const decodeResearchProbeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Number),
      method: Schema.String,
      params: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const encodeResearchProbeReply = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(testLayer)("CodexDriver", (it) => {
  for (const configReadFails of [false, true]) {
    it.effect(
      `reads research web access from the instance and worktree (failure=${configReadFails})`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-web-access-" });
          const cwd = NodePath.join(tempDir, "worktree");
          const homePath = NodePath.join(tempDir, "codex-home");
          const binaryPath = NodePath.join(tempDir, "codex");
          const output = yield* Queue.unbounded<Uint8Array>();
          const requests: Array<{ id?: number; method: string; params?: unknown }> = [];
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          let pending = "";
          let spawned = false;
          const spawner = ChildProcessSpawner.make((command) => {
            if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
            expect(command.command).toBe(binaryPath);
            expect(command.args).toContain("app-server");
            expect(command.args).toContain('web_search="disabled"');
            expect(command.options.cwd).toBe(cwd);
            expect(command.options.env).toMatchObject({
              CODEX_HOME: homePath,
              RESEARCH_PROFILE: "worker",
            });
            spawned = true;
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.never,
                isRunning: Effect.succeed(true),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.forEach((chunk: Uint8Array) =>
                  Effect.gen(function* () {
                    pending += decoder.decode(chunk, { stream: true });
                    const lines = pending.split("\n");
                    pending = lines.pop()!;
                    for (const line of lines) {
                      const request = decodeResearchProbeRequest(line);
                      requests.push(request);
                      if (request.id === undefined) continue;
                      const reply =
                        request.method === "initialize"
                          ? {
                              result: {
                                codexHome: homePath,
                                platformFamily: "unix",
                                platformOs: "linux",
                                userAgent: "test",
                              },
                            }
                          : configReadFails
                            ? { error: { code: -32603, message: "Config unavailable" } }
                            : { result: { config: { web_search: "disabled" }, origins: {} } };
                      yield* Queue.offer(
                        output,
                        encoder.encode(
                          `${encodeResearchProbeReply({ id: request.id, ...reply })}\n`,
                        ),
                      );
                    }
                  }),
                ),
                stdout: Stream.fromQueue(output),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          });
          const instance = yield* CodexDriver.create({
            instanceId: ProviderInstanceId.make("codex-research-worker"),
            displayName: "Research worker",
            enabled: false,
            environment: [{ name: "RESEARCH_PROFILE", value: "worker", sensitive: false }],
            config: {
              ...CodexDriver.defaultConfig(),
              binaryPath,
              homePath,
              launchArgs: `-c 'web_search="disabled"'`,
            },
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
          const access = yield* instance.adapter.researchAccess!(cwd);
          expect(spawned).toBe(true);
          expect(requests.find((request) => request.method === "config/read")?.params).toEqual({
            cwd,
            includeLayers: false,
          });
          expect(
            requests.every((request) =>
              ["initialize", "initialized", "config/read"].includes(request.method),
            ),
          ).toBe(true);
          expect(access).toContain(
            configReadFails ? "Access is unverified" : "web_search is disabled",
          );
        }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(windowsHost)(
    "runs the standalone updater against the shared home, not the shadow home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-driver-" });
        const sharedHome = NodePath.join(tempDir, "codex-home");
        const shadowHome = NodePath.join(tempDir, "codex-shadow");
        const binaryPath = NodePath.join(sharedHome, "packages", "standalone", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-shadow"),
          displayName: "Codex test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          },
        });

        const capabilities = yield* instance.snapshot.resolveMaintenance();
        expect(capabilities.update).toMatchObject({
          executable: binaryPath,
          args: ["update"],
          lockKey: "codex-native",
          env: { CODEX_HOME: sharedHome },
        });
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const instance = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex-missing"),
        displayName: "Codex test",
        enabled: false,
        environment: [],
        config: {
          ...CodexDriver.defaultConfig(),
          binaryPath: NodePath.join(NodeOS.tmpdir(), "t3-codex-missing", "codex"),
        },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  for (const fixture of [
    {
      name: "leaves mise npm-backend installations manual-only",
      installSegments: ["mise", "installs", "npm-openai-codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "leaves mise tool aliases backed by npm manual-only",
      installSegments: ["mise", "installs", "codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "keeps npm updates for globals in a mise Node installation",
      installSegments: ["mise", "installs", "node", "24.0.0"],
      npmOwned: true,
    },
    {
      name: "keeps npm updates for ordinary global installations",
      installSegments: ["npm-global"],
      npmOwned: true,
    },
  ] as const) {
    it.effect.skipIf(windowsHost)(fixture.name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-installer-" });
        const installPath = NodePath.join(tempDir, ...fixture.installSegments);
        const realBinaryPath = NodePath.join(
          installPath,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        const binaryPath = NodePath.join(tempDir, "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(realBinaryPath), { recursive: true });
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(realBinaryPath, "#!/bin/sh\n");
        yield* fs.chmod(realBinaryPath, 0o755);
        yield* fs.symlink(realBinaryPath, binaryPath);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-installer"),
          displayName: "Codex installer test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        });

        const update = (yield* instance.snapshot.resolveMaintenance()).update;
        if (fixture.npmOwned) {
          expect(update).toMatchObject({
            executable: "npm",
            args: [
              "install",
              "-g",
              "--prefix",
              installPath,
              "--allow-scripts=@openai/codex",
              "@openai/codex@latest",
            ],
          });
        } else {
          expect(update).toBeNull();
        }
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
    );
  }

  for (const layout of ["direct", "wrapper"] as const) {
    it.effect.skipIf(windowsHost)(`leaves a mise ${layout} installation manual-only`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: `t3-codex-mise-${layout}-` });
        const binaryPath =
          layout === "direct"
            ? NodePath.join(tempDir, "mise", "installs", "codex", "0.110.0", "codex")
            : NodePath.join(tempDir, "omarchy", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(
          binaryPath,
          layout === "direct"
            ? "#!/bin/sh\n"
            : '#!/bin/sh\nmise use -g --quiet "codex" || exit 1\nexec mise x "codex" -- "codex" "$@"\n',
        );
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make(`codex-mise-${layout}`),
          displayName: "Codex mise test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        });

        expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
    );
  }

  it.effect.each([
    {
      name: "conventional shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "custom data directory",
      dataRoot: "custom-tool-data",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "renamed configured command",
      dataRoot: "mise",
      commandName: "custom-codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "outdated provider",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.3",
      nodeFirst: false,
    },
    {
      name: "npm before shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: true,
    },
  ])(
    "does not mistake Homebrew mise for Codex's installer: $name",
    (fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-mise-shim-" });
        const brewPrefix = NodePath.join(tempDir, "homebrew");
        const brewPath = NodePath.join(brewPrefix, "bin", "brew");
        const misePath = NodePath.join(brewPrefix, "Cellar", "mise", "2026.9.1", "bin", "mise");
        const shimDir = NodePath.join(tempDir, fixture.dataRoot, "shims");
        const npmPrefix = NodePath.join(tempDir, "mise", "installs", "node", "24.13.0");
        const npmBin = NodePath.join(npmPrefix, "bin");
        const npmEntry = NodePath.join(
          npmPrefix,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        for (const file of [brewPath, misePath, npmEntry]) {
          yield* fs.makeDirectory(NodePath.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "#!/bin/sh\n");
          yield* fs.chmod(file, 0o755);
        }
        yield* fs.makeDirectory(shimDir, { recursive: true });
        yield* fs.makeDirectory(npmBin, { recursive: true });
        yield* fs.symlink(misePath, NodePath.join(shimDir, fixture.commandName));
        yield* fs.symlink(npmEntry, NodePath.join(npmBin, fixture.commandName));
        const lookupPath = [
          ...(fixture.nodeFirst ? [npmBin, shimDir] : [shimDir, npmBin]),
          NodePath.dirname(brewPath),
        ].join(NodePath.delimiter);
        const probes: Array<ReadonlyArray<string>> = [];
        const metadataSpawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.command !== brewPath) {
            return Effect.die("Provider resolution must not execute a provider or updater");
          }
          probes.push(command.args);
          const stdout =
            command.args[0] === "--prefix"
              ? brewPrefix
              : JSON.stringify({ formulae: [{ versions: { stable: "2026.9.1" } }] });
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(Stream.make(stdout)),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-mise-shim"),
          displayName: "Codex shim test",
          enabled: false,
          environment: [{ name: "PATH", value: lookupPath, sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath: fixture.commandName,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, metadataSpawner));
        const capabilities = yield* instance.snapshot.resolveMaintenance();
        const latestVersion = yield* resolveLatestProviderVersion(capabilities).pipe(
          Effect.provideService(
            ProviderVersionCache,
            new Map([
              ["@openai/codex", { expiresAt: Number.MAX_SAFE_INTEGER, version: "0.153.4" }],
            ]),
          ),
        );
        expect(probes).toEqual([]);
        expect(latestVersion).toBe("0.153.4");
        expect(
          createProviderVersionAdvisory({
            driver: CodexDriver.driverKind,
            currentVersion: fixture.version,
            latestVersion,
            maintenanceCapabilities: capabilities,
          }),
        ).toMatchObject({
          status: fixture.version === "0.153.4" ? "current" : "behind_latest",
          currentVersion: fixture.version,
          latestVersion: "0.153.4",
          canUpdate: fixture.nodeFirst,
        });
        if (fixture.nodeFirst) {
          expect(capabilities.update).toMatchObject({
            executable: "npm",
            args: expect.arrayContaining(["--prefix", npmPrefix, "@openai/codex@latest"]),
          });
        } else {
          expect(capabilities.update).toBeNull();
        }
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );
});
