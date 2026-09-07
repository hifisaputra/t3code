import type { LinearIssueDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentLinkedThreadIssue, presentThreadIssue } from "./thread-issue-presentation";

const issue: LinearIssueDetail = {
  id: "9f1c0c3a-0c1f-4c3a-9f1c-0c3a0c1f4c3a",
  identifier: "DEL-123",
  title: "Fix login",
  url: "https://linear.app/tomo/issue/DEL-123/fix-login",
  branchName: "tomo/del-123-fix-login",
  priority: 2,
  state: { id: "state-1", name: "In Progress", type: "started", color: "#f2c94c", position: 1 },
  team: { id: "team-1", key: "DEL", name: "Delivery" },
  assignee: null,
  updatedAt: "2026-09-07T10:00:00.000Z",
  description: null,
  comments: [],
  parent: null,
  children: [],
  labels: [],
  project: null,
  cycle: null,
};

describe("presentThreadIssue", () => {
  it("carries the workflow state colour and names the state for assistive technologies", () => {
    expect(presentThreadIssue(issue)).toEqual({
      identifier: "DEL-123",
      title: "Fix login",
      stateName: "In Progress",
      stateType: "started",
      color: "#f2c94c",
      url: "https://linear.app/tomo/issue/DEL-123/fix-login",
      accessibilityLabel: "DEL-123 Fix login, In Progress",
    });
  });
});

describe("presentLinkedThreadIssue", () => {
  it("shows the identifier with no state before the issue loads", () => {
    expect(
      presentLinkedThreadIssue({
        provider: "linear",
        id: issue.id,
        identifier: "DEL-123",
        url: issue.url,
      }),
    ).toEqual({
      identifier: "DEL-123",
      title: "",
      stateName: "",
      stateType: null,
      color: null,
      url: issue.url,
      accessibilityLabel: "DEL-123",
    });
  });
});
