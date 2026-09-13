import { describe, expect, it } from "@effect/vitest";

import type { LinearIssueDetail } from "@t3tools/contracts";

import {
  e2eComment,
  issueFingerprint,
  linearFailureDetail,
  linearFeedback,
} from "./linearUpdates.ts";

const deployment = {
  revision: "641c0f8be4aa833cfd414168ef4389458243bbc2",
  url: "https://staging.garibet.id",
  verifiedAt: "2026-09-13T02:41:14.748Z",
  evidence: [
    {
      targetId: "dashboard",
      revision: "641c0f8be4aa833cfd414168ef4389458243bbc2",
      reference: "https://github.com/Spice-Works/garibet/actions/runs/34731319248",
    },
  ],
};

describe("e2eComment", () => {
  it("leads with the verdict and ends with what T3 verified", () => {
    const body = e2eComment({
      e2e: {
        verdict: "passed",
        report: "- Blog post shows its body: passed",
        humanChecks: [],
        screenshots: [{ url: "https://uploads.linear.app/post.png", caption: "The post" }],
        at: "2026-09-13T03:00:00.000Z",
      },
      merge: { commit: deployment.revision, summary: "Blog posts show their body.", at: "" },
      deployment,
      pullRequest: { number: 83, url: "https://github.com/Spice-Works/garibet/pull/83" },
      acceptedState: "Done",
    });
    expect(body).toBe(
      [
        "**✅ Verified on staging: ready to accept**",
        "**What changed**\n\nBlog posts show their body.",
        "**Staging check**\n\n- Blog post shows its body: passed",
        "*The post*\n\n![The post](https://uploads.linear.app/post.png)",
        "---",
        "To accept, move this issue to Done. To ask for changes, move it back to an earlier state and comment what should change.",
        [
          "- Staging: [staging.garibet.id](https://staging.garibet.id)",
          "- Deployed commit: `641c0f8`",
          "- Deployments: [dashboard](https://github.com/Spice-Works/garibet/actions/runs/34731319248)",
          "- Pull request: [#83](https://github.com/Spice-Works/garibet/pull/83)",
        ].join("\n"),
      ].join("\n\n"),
    );
  });
});

describe("linearFeedback", () => {
  it("asks the person when they moved the issue back without saying why", () => {
    expect(
      linearFeedback({ comments: [], since: "", postedIds: [], stateName: "In Progress" }),
    ).toBe(
      "Moved back to In Progress in Linear without a comment. Ask the person what should change.",
    );
  });
});

describe("linearFailureDetail", () => {
  it("keeps Linear's own reason", () => {
    expect(linearFailureDetail({ detail: "Linear refused to add the comment." })).toBe(
      "Linear refused to add the comment.",
    );
    expect(linearFailureDetail({ reason: "unconfigured" })).toBe("Linear is not connected.");
    expect(linearFailureDetail(new Error("boom"))).toBe("Linear did not accept the request.");
  });
});

describe("issueFingerprint", () => {
  const issue: LinearIssueDetail = {
    id: "issue-1",
    identifier: "SPI-1",
    title: "Blog images",
    url: "https://linear.app/spi/issue/SPI-1",
    branchName: "spi-1",
    priority: 2,
    updatedAt: "2026-09-13T00:00:00.000Z",
    state: { id: "todo", name: "Todo", type: "unstarted", position: 0, color: "#fff" },
    team: { id: "team", key: "SPI", name: "Spiceworks" },
    assignee: null,
    project: null,
    cycle: null,
    description: "Images break.",
    comments: [],
    labels: [],
    children: [],
    parent: null,
  };
  const comment = (id: string, body: string) => ({
    id,
    body,
    url: "",
    createdAt: "2026-09-13T00:01:00.000Z",
    // T3 posts as the connected account, so authorship cannot tell its comments apart.
    author: { id: "me", name: "Me", displayName: "Me" },
  });

  it("ignores the comments T3 posted and the time Linear last touched the issue", () => {
    const before = issueFingerprint(issue, []);
    const withOwnComment = {
      ...issue,
      updatedAt: "2026-09-13T00:05:00.000Z",
      comments: [comment("t3", "Not taken by the developer assistant")],
    };
    expect(issueFingerprint(withOwnComment, ["t3"])).toBe(before);
  });

  it("changes when a person edits the issue or comments on it", () => {
    const before = issueFingerprint(issue, []);
    expect(issueFingerprint({ ...issue, description: "Images break on save." }, [])).not.toBe(
      before,
    );
    expect(
      issueFingerprint({ ...issue, labels: [{ id: "bug", name: "Bug", color: "#f00" }] }, []),
    ).not.toBe(before);
    expect(
      issueFingerprint({ ...issue, comments: [comment("person", "Blocked by SPI-2")] }, []),
    ).not.toBe(before);
  });
});
