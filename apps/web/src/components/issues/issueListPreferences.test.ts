import { describe, expect, it } from "vite-plus/test";

import { readIssueListPreferences, writeIssueListPreferences } from "./issueListPreferences";

describe("issue assignment preferences", () => {
  it("restores all issues and can switch back to assigned issues", () => {
    let saved: string | null = null;
    const storage = {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    };

    writeIssueListPreferences({ state: "active", scope: "all", team: "DEL" }, storage);
    expect(readIssueListPreferences(storage)).toEqual({
      state: "active",
      scope: "all",
      team: "DEL",
    });

    writeIssueListPreferences({ state: "active", team: "DEL" }, storage);
    expect(readIssueListPreferences(storage)).toEqual({ state: "active", team: "DEL" });
  });

  it("preserves filters saved before the assignment switch existed", () => {
    const storage = {
      getItem: () => JSON.stringify({ state: "backlog", team: "DEL" }),
      setItem: () => {},
    };

    expect(readIssueListPreferences(storage)).toEqual({ state: "backlog", team: "DEL" });
  });
});
