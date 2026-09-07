import type { ThreadLinkedIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadIssuePresentation,
  type ThreadIssuePresentation,
} from "./thread-issue-presentation";

const link: ThreadLinkedIssue = {
  provider: "linear",
  id: "9f1c0c3a-0c1f-4c3a-9f1c-0c3a0c1f4c3a",
  identifier: "DEL-123",
  url: "https://linear.app/tomo/issue/DEL-123/fix-login",
};

const loaded: ThreadIssuePresentation = {
  identifier: "DEL-123",
  title: "Fix login",
  stateName: "In Progress",
  stateType: "started",
  color: "#f2c94c",
  url: link.url,
  accessibilityLabel: "DEL-123 Fix login, In Progress",
};

const stale: ThreadIssuePresentation = { ...loaded, stateName: "Todo", stateType: "unstarted" };

describe("resolveThreadIssuePresentation", () => {
  it("shows nothing for a thread with no linked issue", () => {
    expect(resolveThreadIssuePresentation({ link: null, live: null, snapshot: stale })).toBeNull();
  });

  it("shows the identifier alone while the issue query has no data", () => {
    expect(resolveThreadIssuePresentation({ link, live: undefined, snapshot: null })).toMatchObject(
      { identifier: "DEL-123", stateName: "", color: null, url: link.url },
    );
  });

  it("keeps the last presentation when a recycled row re-requests the issue", () => {
    expect(resolveThreadIssuePresentation({ link, live: undefined, snapshot: stale })).toBe(stale);
  });

  it("prefers the live issue over the cached one", () => {
    expect(resolveThreadIssuePresentation({ link, live: loaded, snapshot: stale })).toBe(loaded);
  });
});
