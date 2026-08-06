import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  clearWorkspaceImageUrlCache,
  forgetWorkspaceImageUrl,
  readWorkspaceImageUrl,
  rememberWorkspaceImageUrl,
  workspaceImageCacheKey,
} from "./workspaceImageUrlCache";

const environmentId = EnvironmentId.make("env-1");
const otherEnvironmentId = EnvironmentId.make("env-2");
const now = 1_000_000;
const hour = 60 * 60 * 1000;

describe("workspaceImageUrlCache", () => {
  beforeEach(() => {
    clearWorkspaceImageUrlCache();
  });

  const remember = (key: string, url: string, expiresAt = now + hour) => {
    rememberWorkspaceImageUrl(key, { url, expiresAt });
  };

  it("hands a resolved URL back to a later mount", () => {
    const key = workspaceImageCacheKey(environmentId, ".t3-images/a.png");
    remember(key, "https://host/api/assets/token/a.png");

    expect(readWorkspaceImageUrl(key, now)).toBe("https://host/api/assets/token/a.png");
  });

  it("keeps environments apart", () => {
    remember(workspaceImageCacheKey(environmentId, ".t3-images/a.png"), "https://host/one");

    expect(
      readWorkspaceImageUrl(workspaceImageCacheKey(otherEnvironmentId, ".t3-images/a.png"), now),
    ).toBeNull();
  });

  it("drops a token before it expires so a slow load still finishes", () => {
    const key = workspaceImageCacheKey(environmentId, ".t3-images/a.png");
    remember(key, "https://host/one", now + 30_000);

    expect(readWorkspaceImageUrl(key, now)).toBeNull();
    expect(readWorkspaceImageUrl(key, now)).toBeNull();
  });

  it("forgets a URL the browser could not load", () => {
    const key = workspaceImageCacheKey(environmentId, ".t3-images/a.png");
    remember(key, "https://host/one");
    forgetWorkspaceImageUrl(key);

    expect(readWorkspaceImageUrl(key, now)).toBeNull();
  });

  it("evicts the least recently used entry once full", () => {
    const keyAt = (index: number) =>
      workspaceImageCacheKey(environmentId, `.t3-images/${index}.png`);
    for (let index = 0; index < 512; index += 1) remember(keyAt(index), `https://host/${index}`);
    // Touch the oldest entry so the next insert evicts the second oldest instead.
    expect(readWorkspaceImageUrl(keyAt(0), now)).toBe("https://host/0");
    remember(keyAt(512), "https://host/512");

    expect(readWorkspaceImageUrl(keyAt(0), now)).toBe("https://host/0");
    expect(readWorkspaceImageUrl(keyAt(1), now)).toBeNull();
    expect(readWorkspaceImageUrl(keyAt(512), now)).toBe("https://host/512");
  });
});
