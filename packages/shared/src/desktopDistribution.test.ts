import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  desktopDistributionScheme,
  normalizeDesktopDistributionId,
  resolveDesktopDistributionId,
  resolveDesktopDistributionNames,
} from "./desktopDistribution.ts";

describe("desktopDistribution", () => {
  it("keeps the official names when no distribution is set", () => {
    const names = resolveDesktopDistributionNames(Option.none());
    assert.equal(names.baseName, "T3 Code");
    assert.equal(names.slug, "t3code");
    assert.equal(names.appId, "com.t3tools.t3code");
    assert.equal(names.baseDirName, ".t3");
    assert.equal(names.artifactPrefix, "T3-Code");
    assert.equal(desktopDistributionScheme(Option.none(), false), "t3code");
    assert.equal(desktopDistributionScheme(Option.none(), true), "t3code-dev");
  });

  it("derives every colliding name from the distribution id", () => {
    const names = resolveDesktopDistributionNames(Option.some("fork"));
    assert.equal(names.baseName, "T3 Code Fork");
    assert.equal(names.slug, "t3code-fork");
    assert.equal(names.appId, "com.t3tools.t3code.fork");
    assert.equal(names.baseDirName, ".t3-fork");
    assert.equal(names.artifactPrefix, "T3-Code-fork");
    assert.equal(desktopDistributionScheme(Option.some("fork"), false), "t3code-fork");
    assert.equal(desktopDistributionScheme(Option.some("fork"), true), "t3code-fork-dev");
    assert.equal(
      resolveDesktopDistributionNames(Option.some("tomo-dev")).baseName,
      "T3 Code Tomo Dev",
    );
  });

  it("rejects ids that would not survive a scheme, bundle id or file name", () => {
    for (const bad of ["", "Fork", "my fork", "-fork", "fork-", "fork--x", "f.o", 42, null]) {
      assert.isTrue(Option.isNone(normalizeDesktopDistributionId(bad)), String(bad));
    }
    assert.deepEqual(normalizeDesktopDistributionId("  fork "), Option.some("fork"));
  });

  it("prefers the environment override, then the packaged package.json field", () => {
    const fromEnv = resolveDesktopDistributionId({
      env: { T3CODE_DESKTOP_DISTRIBUTION: "local" },
      readPackageJson: () => JSON.stringify({ t3codeDistribution: "fork" }),
    });
    assert.deepEqual(fromEnv, Option.some("local"));

    const fromPackage = resolveDesktopDistributionId({
      env: {},
      readPackageJson: () => JSON.stringify({ t3codeDistribution: "fork" }),
    });
    assert.deepEqual(fromPackage, Option.some("fork"));

    assert.isTrue(
      Option.isNone(resolveDesktopDistributionId({ env: {}, readPackageJson: () => "{" })),
    );
    assert.isTrue(
      Option.isNone(resolveDesktopDistributionId({ env: {}, readPackageJson: () => null })),
    );
    assert.isTrue(
      Option.isNone(
        resolveDesktopDistributionId({
          env: { T3CODE_DESKTOP_DISTRIBUTION: "Bad Id" },
          readPackageJson: () => JSON.stringify({ version: "1.0.0" }),
        }),
      ),
    );
  });
});
