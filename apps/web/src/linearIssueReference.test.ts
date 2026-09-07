import { describe, expect, it } from "vite-plus/test";

import { isLinearIssueUrl, parseLinearIssueReference } from "./linearIssueReference";

describe("parseLinearIssueReference", () => {
  it("accepts a bare identifier", () => {
    expect(parseLinearIssueReference("DEL-123")).toBe("DEL-123");
  });

  it("upper-cases a lower-case identifier", () => {
    expect(parseLinearIssueReference("del-123")).toBe("DEL-123");
  });

  it("accepts a #-prefixed identifier", () => {
    expect(parseLinearIssueReference("#DEL-123")).toBe("DEL-123");
  });

  it("ignores surrounding whitespace", () => {
    expect(parseLinearIssueReference("  del-7  ")).toBe("DEL-7");
  });

  it("accepts an issue URL with a slug", () => {
    expect(
      parseLinearIssueReference("https://linear.app/tomo/issue/DEL-123/fix-the-login-page"),
    ).toBe("DEL-123");
  });

  it("accepts an issue URL without a slug", () => {
    expect(parseLinearIssueReference("https://linear.app/tomo/issue/del-123")).toBe("DEL-123");
  });

  it("accepts an issue URL with a trailing slash", () => {
    expect(parseLinearIssueReference("https://linear.app/tomo/issue/DEL-123/")).toBe("DEL-123");
  });

  it("accepts an issue URL with a query string", () => {
    expect(parseLinearIssueReference("https://linear.app/tomo/issue/DEL-123/slug?foo=bar")).toBe(
      "DEL-123",
    );
  });

  it("rejects a pull request number", () => {
    expect(parseLinearIssueReference("42")).toBeNull();
    expect(parseLinearIssueReference("#42")).toBeNull();
  });

  it("rejects a pull request URL", () => {
    expect(parseLinearIssueReference("https://github.com/pingdotgg/t3code/pull/42")).toBeNull();
  });

  it("rejects a branch name that merely contains an identifier", () => {
    expect(parseLinearIssueReference("tomo/del-123-fix-login")).toBeNull();
  });

  it("rejects junk", () => {
    expect(parseLinearIssueReference("")).toBeNull();
    expect(parseLinearIssueReference("not an issue")).toBeNull();
    expect(parseLinearIssueReference("DEL-")).toBeNull();
    expect(parseLinearIssueReference("-123")).toBeNull();
  });

  it("rejects a linear.app URL that is not an issue", () => {
    expect(parseLinearIssueReference("https://linear.app/tomo/project/roadmap")).toBeNull();
  });
});

describe("isLinearIssueUrl", () => {
  it("is true for an issue URL", () => {
    expect(isLinearIssueUrl("https://linear.app/tomo/issue/DEL-123/fix-login")).toBe(true);
  });

  it("is false for a bare identifier", () => {
    expect(isLinearIssueUrl("DEL-123")).toBe(false);
  });

  it("is false for another host", () => {
    expect(isLinearIssueUrl("https://github.com/pingdotgg/t3code/pull/42")).toBe(false);
  });
});
