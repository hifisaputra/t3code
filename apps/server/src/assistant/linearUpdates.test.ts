import { describe, expect, it } from "@effect/vitest";

import type { LinearIssueDetail } from "@t3tools/contracts";

import {
  DELIVERED_MARKER_END,
  DELIVERED_MARKER_START,
  deliveredDescription,
  e2eComment,
  issueFingerprint,
  linearFailureDetail,
  linearFeedback,
  mergedComment,
  sessionNotes,
  withSessionNote,
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
        "**E2E check on staging**\n\n- Blog post shows its body: passed",
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

  it("puts the per-criterion results in a table above the tester's report", () => {
    const body = e2eComment({
      e2e: {
        verdict: "partial",
        report: "The reminder email could not be read from staging.",
        checks: [
          {
            criterion: 1,
            result: "passed",
            evidence: "Opened /blog/hello and saw the body.",
            screenshot: 1,
          },
          { criterion: 2, result: "not-checked", evidence: "No test inbox on staging." },
        ],
        humanChecks: ["Open the reminder email in the test inbox."],
        screenshots: [{ url: "https://uploads.linear.app/post.png", caption: "The post" }],
        at: "2026-09-13T03:00:00.000Z",
      },
      merge: { commit: deployment.revision, summary: "Blog posts show their body.", at: "" },
      deployment,
      pullRequest: null,
      acceptedState: "Done",
      criteria: ["A blog post shows its body", "The author gets a reminder email"],
    });
    expect(body).toContain("| Criterion | Result | Evidence |");
    expect(body).toContain(
      "| A blog post shows its body | ✅ passed | Opened /blog/hello and saw the body. *The post* |",
    );
    expect(body).toContain(
      "| The author gets a reminder email | 👀 not checked | No test inbox on staging. |",
    );
    // The table sits above the free report, which says what was not covered.
    expect(body.indexOf("| Criterion |")).toBeLessThan(body.indexOf("**E2E check on staging**"));
  });

  it("leaves the table out for an issue with no recorded criteria", () => {
    const body = e2eComment({
      e2e: {
        verdict: "passed",
        report: "- Blog post shows its body: passed",
        humanChecks: [],
        screenshots: [],
        at: "2026-09-13T03:00:00.000Z",
      },
      merge: null,
      deployment,
      pullRequest: null,
      acceptedState: "Done",
    });
    expect(body).not.toContain("| Criterion |");
  });

  it("says a worktree run was verified in the development environment and names its commit", () => {
    const body = e2eComment({
      e2e: {
        verdict: "partial",
        report: "- Blog post shows its body: passed",
        humanChecks: ["Open the reminder email in the test inbox."],
        screenshots: [],
        at: "2026-09-13T03:00:00.000Z",
        environment: "worktree",
        commit: deployment.revision,
      },
      merge: { commit: deployment.revision, summary: "Blog posts show their body.", at: "" },
      deployment,
      pullRequest: null,
      acceptedState: "Done",
    });
    expect(
      body.startsWith(
        "**👀 Verified in the development environment and deployed to staging, with checks for a person**",
      ),
    ).toBe(true);
    expect(body).toContain("**E2E check in the worktree (commit `641c0f8`)**");
    expect(body).not.toContain("**E2E check on staging**");
  });
});

describe("mergedComment", () => {
  const merge = { commit: deployment.revision, summary: "Blog posts show their body.", at: "" };
  const review = {
    verdict: "approved" as const,
    findings: "",
    summary: "Checked the rendering path.",
    commit: deployment.revision,
    at: "2026-09-13T02:00:00.000Z",
  };
  const input = { merge, review, pullRequest: null, baseBranch: "main" };

  it("points at the e2e check on staging when the run happens there", () => {
    const body = mergedComment(input);
    expect(body.startsWith("**Code review passed · merged into `main`**")).toBe(true);
    expect(body.endsWith("Next: staging deploy, then an e2e check on staging.")).toBe(true);
  });

  it("says the e2e check already passed when it ran in the worktree", () => {
    const body = mergedComment({
      ...input,
      e2e: {
        verdict: "partial",
        report: "- Blog post shows its body: passed",
        humanChecks: ["Open the reminder email in the test inbox."],
        screenshots: [],
        at: "2026-09-13T03:00:00.000Z",
        environment: "worktree",
        commit: deployment.revision,
      },
    });
    expect(
      body.startsWith(
        "**Code review passed · e2e passed in the development environment · merged into `main`**",
      ),
    ).toBe(true);
    expect(body).toContain("left some checks for a person");
    expect(
      body.endsWith("Next: staging deploy. The issue moves to review once it is verified there."),
    ).toBe(true);
  });
});

describe("deliveredDescription", () => {
  const e2e = {
    verdict: "partial" as const,
    report: "- Blog post shows its body: passed",
    humanChecks: ["Open the reminder email in the test inbox."],
    screenshots: [],
    at: "2026-09-13T03:00:00.000Z",
  };
  const merge = { commit: deployment.revision, summary: "Blog posts show their body.", at: "" };
  const input = { current: "Images break.", merge, e2e, deployment, acceptedState: "Done" };

  it("keeps the person's description and adds what shipped below it", () => {
    expect(deliveredDescription(input)).toBe(
      [
        "Images break.",
        "",
        DELIVERED_MARKER_START,
        "## What shipped",
        "",
        "Delivered to staging and waiting to be accepted. Move this issue to Done to accept it.",
        "",
        "Blog posts show their body.",
        "",
        "**Check before accepting**",
        "",
        "1. Open the reminder email in the test inbox.",
        "",
        "Staging: [staging.garibet.id](https://staging.garibet.id)",
        DELIVERED_MARKER_END,
      ].join("\n"),
    );
  });

  it("replaces its own section rather than stacking a second one", () => {
    const first = deliveredDescription(input);
    const second = deliveredDescription({
      ...input,
      current: `${first}\n\nAdded later by the person.`,
      merge: { ...merge, summary: "Blog posts show their body and their cover image." },
    });
    expect(second.split(DELIVERED_MARKER_START)).toHaveLength(2);
    expect(second).toContain("Blog posts show their body and their cover image.");
    expect(second).not.toContain("Blog posts show their body.\n");
    expect(second.startsWith("Images break.\n")).toBe(true);
    expect(second.endsWith("Added later by the person.")).toBe(true);
  });

  it("is the section alone when the issue has no description", () => {
    for (const current of [null, "   "])
      expect(deliveredDescription({ ...input, current }).startsWith(DELIVERED_MARKER_START)).toBe(
        true,
      );
  });

  it("leaves out the checks when a person has nothing to check", () => {
    const body = deliveredDescription({
      ...input,
      e2e: { ...e2e, verdict: "passed", humanChecks: [] },
    });
    expect(body).not.toContain("Check before accepting");
    expect(body).toContain("Blog posts show their body.");
  });

  it("points at the comments when the implementer reported no summary", () => {
    const body = deliveredDescription({ ...input, merge: null, acceptedState: "" });
    expect(body).toContain("See the developer assistant's comments below for what changed.");
    expect(body).toContain("Move this issue to a completed state to accept it.");
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

  it("adds replies from the Linear session after the comments, leaving earlier feedback out", () => {
    const feedback = withSessionNote(
      withSessionNote("Requested in Linear (moved to Todo):\n\nOld round.", "Make it blue."),
      "And bigger.",
    );
    expect(sessionNotes("Old round.")).toBeNull();
    expect(sessionNotes(feedback)).toBe("Make it blue.\n\nAnd bigger.");
    expect(
      linearFeedback({
        comments: [{ id: "c1", body: "Wrong colour", createdAt: "2" }],
        since: "1",
        postedIds: [],
        stateName: "Todo",
        notes: sessionNotes(feedback),
      }),
    ).toBe("Requested in Linear (moved to Todo):\n\nWrong colour\n\nMake it blue.\n\nAnd bigger.");
  });

  it("leaves out the app's own session replies and replies already kept as notes", () => {
    expect(
      linearFeedback({
        comments: [
          {
            id: "c1",
            body: "**Verified on staging: ready to accept**",
            createdAt: "2",
            authorIsApp: true,
          },
          { id: "c2", body: "Make it blue.", createdAt: "3" },
          { id: "c3", body: "Wrong colour", createdAt: "4" },
        ],
        since: "1",
        postedIds: [],
        stateName: "Todo",
        notes: "Make it blue.",
      }),
    ).toBe("Requested in Linear (moved to Todo):\n\nWrong colour\n\nMake it blue.");
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

  it("ignores an old comment leaving the window Linear returns", () => {
    // Linear hands back the newest comments first, so a decline comment of T3's own
    // pushes the oldest one out of the 50 it reads. Nobody changed the issue.
    const thread = Array.from({ length: 50 }, (_, i) => ({
      ...comment(`person-${i}`, `Comment ${i}`),
      createdAt: `2026-09-13T00:${String(i).padStart(2, "0")}:00.000Z`,
    }));
    const before = issueFingerprint({ ...issue, comments: thread }, []);
    const declined = {
      ...issue,
      comments: [
        {
          ...comment("t3", "Not taken by the developer assistant"),
          createdAt: "2026-09-13T01:00:00.000Z",
        },
        ...thread.slice(1),
      ],
    };
    expect(issueFingerprint(declined, ["t3"])).toBe(before);
    expect(
      issueFingerprint(
        {
          ...declined,
          comments: [
            ...declined.comments,
            { ...comment("person-new", "Please redo"), createdAt: "2026-09-13T02:00:00.000Z" },
          ],
        },
        ["t3"],
      ),
    ).not.toBe(before);
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
