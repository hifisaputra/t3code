import { describe, expect, it } from "@effect/vitest";

import type { AssistantResearch, LinearIssueDetail } from "@t3tools/contracts";

import {
  DELIVERED_MARKER_END,
  DELIVERED_MARKER_START,
  deliveredDescription,
  e2eComment,
  issueFingerprint,
  linearFailureDetail,
  linearFeedback,
  mergedComment,
  noE2eComment,
  researchComments,
  researchShortAnswer,
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
  const merge = { commit: deployment.revision, summary: "Blog posts show their body.", at: "" };
  const footer = [
    "---",
    "What shipped is in the issue description.",
    "To accept, move this issue to Done. To ask for changes, move it back to an earlier state and comment what should change.",
    [
      "- Staging: [staging.garibet.id](https://staging.garibet.id)",
      "- Deployed commit: `641c0f8`",
      "- Deployments: [dashboard](https://github.com/Spice-Works/garibet/actions/runs/34731319248)",
      "- Pull request: [#83](https://github.com/Spice-Works/garibet/pull/83)",
    ].join("\n"),
  ].join("\n\n");
  const screenshots = Array.from({ length: 12 }, (_, i) => ({
    url: `https://uploads.linear.app/shot-${i + 1}.png`,
    caption: `State ${i + 1}`,
  }));
  const withCriteria = {
    e2e: {
      verdict: "partial" as const,
      report: "### Not covered\n- The reminder email could not be read from staging.",
      checks: [
        {
          criterion: 1,
          result: "passed" as const,
          evidence: "Opened /blog/hello\nand saw the body.",
          screenshot: 1,
        },
        { criterion: 2, result: "not-checked" as const, evidence: "No test inbox on staging." },
      ],
      humanChecks: ["Open the reminder email in the test inbox."],
      worthALook: ["The footer still says | Read more."],
      screenshots,
      at: "2026-09-13T03:00:00.000Z",
    },
    merge,
    deployment,
    pullRequest: { number: 83, url: "https://github.com/Spice-Works/garibet/pull/83" },
    acceptedState: "Done",
    criteria: ["A blog post shows its body", "The author gets a reminder email"],
  };

  it("puts checks, results, notes and screenshots up top and collapses the evidence and report", () => {
    expect(e2eComment(withCriteria)).toBe(
      [
        "**👀 Verified on staging, with checks for a person**",
        "**Check before accepting**\n\n1. Open the reminder email in the test inbox.",
        [
          "| Criterion | Result |",
          "| --- | --- |",
          "| A blog post shows its body | ✅ passed (screenshot 1) |",
          "| The author gets a reminder email | 👀 not checked |",
        ].join("\n"),
        "**Worth a look**\n\n- The footer still says | Read more.",
        [
          "**Screenshots**",
          ...screenshots.map(
            (shot, i) =>
              `*Screenshot ${i + 1}: ${shot.caption}*\n\n![${shot.caption}](${shot.url})`,
          ),
        ].join("\n\n"),
        [
          "+++ Evidence per criterion",
          [
            "1. **A blog post shows its body** ✅ passed (screenshot 1): Opened /blog/hello and saw the body.",
            "2. **The author gets a reminder email** 👀 not checked: No test inbox on staging.",
          ].join("\n"),
          "+++",
        ].join("\n\n"),
        [
          "+++ Tester's full report",
          "### Not covered\n- The reminder email could not be read from staging.",
          "+++",
        ].join("\n\n"),
        footer,
      ].join("\n\n"),
    );
  });

  it("keeps every screenshot, and the evidence out of the table", () => {
    const body = e2eComment(withCriteria);
    expect(body.match(/!\[/g)).toHaveLength(12);
    expect(body).not.toContain("| Evidence |");
    expect(body.split("+++ Evidence per criterion")[0]).not.toContain("No test inbox on staging.");
  });

  it("embeds recordings after the screenshots and points each check at its evidence", () => {
    const videos = [
      { url: "https://uploads.linear.app/signup.webm", caption: "Signing up, step by step" },
    ];
    const body = e2eComment({
      ...withCriteria,
      e2e: {
        ...withCriteria.e2e,
        screenshots: screenshots.slice(0, 2),
        checks: [
          { ...withCriteria.e2e.checks[0]!, screenshot: 2, video: 1 },
          { criterion: 2, result: "passed" as const, evidence: "Saw the email.", video: 1 },
        ],
        videos,
      },
    });
    expect(body).toContain("| A blog post shows its body | ✅ passed (screenshot 2, video 1) |");
    expect(body).toContain("| The author gets a reminder email | ✅ passed (video 1) |");
    expect(body).toContain(
      "2. **The author gets a reminder email** ✅ passed (video 1): Saw the email.",
    );
    const recordings =
      "**Recordings**\n\n*Video 1: Signing up, step by step*\n\n![Signing up, step by step](https://uploads.linear.app/signup.webm)";
    expect(body).toContain(
      `![State 2](https://uploads.linear.app/shot-2.png)\n\n${recordings}\n\n+++ Evidence`,
    );
  });

  it("leaves out recordings, and a video reference to a missing clip, when there are none", () => {
    const body = e2eComment({
      ...withCriteria,
      e2e: {
        ...withCriteria.e2e,
        checks: [{ ...withCriteria.e2e.checks[0]!, video: 1 }, withCriteria.e2e.checks[1]!],
      },
    });
    expect(body).not.toContain("**Recordings**");
    expect(body).not.toContain("video 1");
  });

  it("leaves out the notes and screenshots headings when there are none", () => {
    const body = e2eComment({
      ...withCriteria,
      e2e: {
        ...withCriteria.e2e,
        worthALook: [" "],
        screenshots: [],
        checks: [withCriteria.e2e.checks[1]!],
      },
    });
    expect(body).not.toContain("Worth a look");
    expect(body).not.toContain("**Screenshots**");
    expect(body).not.toContain("(screenshot");
  });

  it("keeps a line of +++ in the report or evidence from closing the collapsed section", () => {
    const body = e2eComment({
      ...withCriteria,
      e2e: {
        ...withCriteria.e2e,
        report: "Before\n+++\n  +++ Nested\nAfter",
        checks: [
          { ...withCriteria.e2e.checks[0]!, evidence: "+++\nsaw it" },
          withCriteria.e2e.checks[1]!,
        ],
      },
    });
    expect(body.split("\n").filter((line) => line.trim().startsWith("+++"))).toEqual([
      "+++ Evidence per criterion",
      "+++",
      "+++ Tester's full report",
      "+++",
    ]);
    expect(body).toContain("Before\n\\+++\n  \\+++ Nested\nAfter");
    expect(body).toContain("✅ passed (screenshot 1): +++ saw it");
  });

  it("puts the engineering checks and how the team settled them in the collapsed report", () => {
    const body = e2eComment({
      ...withCriteria,
      e2e: {
        ...withCriteria.e2e,
        engineeringChecks: ["No hydration warning in the dev console on /blog/hello"],
        engineeringSettled: "The reviewer ran the dev build and the console stayed clean.",
      },
    });
    expect(body.split("+++ Tester's full report")[0]).not.toContain("Engineering checks");
    // With the open criteria all settled by the team, the person has nothing to check.
    const settledOnly = e2eComment({
      ...withCriteria,
      e2e: { ...withCriteria.e2e, humanChecks: [], engineeringChecks: ["Logs"] },
    });
    expect(settledOnly.split("\n")[0]).toBe("**✅ Verified on staging: ready to accept**");
    expect(body).toContain(
      [
        "+++ Tester's full report",
        [
          "### Not covered\n- The reminder email could not be read from staging.",
          "**Engineering checks**\n\n1. No hydration warning in the dev console on /blog/hello",
          "**Settled by the team**\n\nThe reviewer ran the dev build and the console stayed clean.",
        ].join("\n\n"),
        "+++",
      ].join("\n\n"),
    );
  });

  it("shows the report open, under its own heading, for an issue with no recorded criteria", () => {
    const body = e2eComment({
      e2e: {
        verdict: "passed",
        report: "- Blog post shows its body: passed",
        humanChecks: [],
        screenshots: [{ url: "https://uploads.linear.app/post.png", caption: "The post" }],
        at: "2026-09-13T03:00:00.000Z",
      },
      merge,
      deployment,
      pullRequest: { number: 83, url: "https://github.com/Spice-Works/garibet/pull/83" },
      acceptedState: "Done",
    });
    expect(body).toBe(
      [
        "**✅ Verified on staging: ready to accept**",
        "**Screenshots**\n\n*Screenshot 1: The post*\n\n![The post](https://uploads.linear.app/post.png)",
        "**E2E check on staging**\n\n- Blog post shows its body: passed",
        footer,
      ].join("\n\n"),
    );
    expect(body).not.toContain("+++");
    expect(body).not.toContain("| Criterion |");
  });

  it("points at the description only when delivery writes what shipped there", () => {
    const failed = e2eComment({
      ...withCriteria,
      e2e: {
        ...withCriteria.e2e,
        verdict: "failed",
        checks: [{ ...withCriteria.e2e.checks[0]!, result: "failed" }],
      },
    });
    expect(failed.startsWith("**❌ Failed on staging")).toBe(true);
    expect(failed).not.toContain("What shipped");
    expect(failed).not.toContain("To accept");
    // Without an implementer's summary the description has none to point at.
    expect(e2eComment({ ...withCriteria, merge: null })).not.toContain("What shipped");
  });

  it("says a worktree run was verified in the development environment and names its commit", () => {
    const e2e = {
      verdict: "partial" as const,
      report: "- Blog post shows its body: passed",
      humanChecks: ["Open the reminder email in the test inbox."],
      screenshots: [],
      at: "2026-09-13T03:00:00.000Z",
      environment: "worktree" as const,
      commit: deployment.revision,
    };
    const body = e2eComment({ e2e, merge, deployment, pullRequest: null, acceptedState: "Done" });
    expect(
      body.startsWith(
        "**👀 Verified in the development environment and deployed to staging, with checks for a person**",
      ),
    ).toBe(true);
    expect(body).toContain("**E2E check in the worktree (commit `641c0f8`)**");
    expect(body).not.toContain("**E2E check on staging**");
    const checked = e2eComment({
      ...withCriteria,
      e2e: { ...withCriteria.e2e, environment: "worktree", commit: deployment.revision },
    });
    expect(checked).toContain("+++ Tester's full report (tested commit 641c0f8)");
  });

  it("says a smoke test ran and marks the criteria it left out", () => {
    const body = e2eComment({
      ...withCriteria,
      smoke: true,
      e2e: {
        ...withCriteria.e2e,
        verdict: "passed",
        humanChecks: [],
        checks: [
          withCriteria.e2e.checks[0]!,
          { criterion: 2, result: "skipped", evidence: "Not in the smoke test" },
        ],
      },
    });
    expect(body.startsWith("**✅ Smoke test passed on staging: ready to accept**")).toBe(true);
    expect(body).toContain("| The author gets a reminder email | ➖ not in the smoke test |");
    expect(body).toContain(
      "2. **The author gets a reminder email** ➖ not in the smoke test: Not in the smoke test",
    );
    expect(body.endsWith(footer)).toBe(true);
  });
});

describe("noE2eComment", () => {
  const input = {
    reason: "Only the lint config changes.",
    decidedBy: "lead" as const,
    merge: { commit: deployment.revision, summary: "Lint runs on CI.", at: "" },
    deployment,
    pullRequest: { number: 83, url: "https://github.com/Spice-Works/garibet/pull/83" },
    acceptedState: "Done",
  };

  it("gives the reason and who decided, then the footer of a delivery card", () => {
    expect(noE2eComment(input)).toBe(
      [
        "**No e2e test: Only the lint config changes** (decided by the team leader)",
        "---",
        "What shipped is in the issue description.",
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

  it("says the person chose no test on the board", () => {
    const body = noE2eComment({
      ...input,
      decidedBy: "person",
      reason: "Set by the person on the board.",
    });
    expect(body.split("\n")[0]).toBe("**No e2e test: set by the person on the board**");
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

  it("points straight at review when the issue runs no e2e test", () => {
    expect(
      mergedComment({ ...input, noE2e: true }).endsWith(
        "Next: staging deploy. The issue moves to review once it is verified there.",
      ),
    ).toBe(true);
  });

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

  it("works for an issue delivered without an e2e test", () => {
    const body = deliveredDescription({ ...input, e2e: null });
    expect(body).not.toContain("Check before accepting");
    expect(body).toContain("Blog posts show their body.");
    expect(body).toContain("Staging: [staging.garibet.id](https://staging.garibet.id)");
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

describe("researchComments", () => {
  const research: AssistantResearch = {
    report:
      "## Short answer\n\n- Acme charges $10 per seat [1].\n- Globex has no public price [2].\n\n## Detail\n\nAcme's tiers are Basic and Pro [1].",
    sources: [
      { url: "https://acme.example/pricing", title: "Acme [pricing]", seen: "2026-09-18" },
      { url: "https://globex.example/plans", title: "Globex plans", seen: "2026-09-17" },
    ],
    checks: [
      { criterion: 1, result: "answered", evidence: "Short answer, first line.", screenshot: 1 },
      { criterion: 2, result: "not-answered", evidence: "Globex asks for a sales call." },
    ],
    screenshots: [
      {
        path: "/evidence/t/acme.png",
        caption: "Acme pricing page",
        url: "https://uploads.linear.app/acme.png",
      },
      { path: "/evidence/t/globex.png", caption: "Globex plans page" },
    ],
    revision: 2,
    at: "2026-09-18T00:00:00.000Z",
    review: {
      verdict: "approved",
      findings: "",
      summary: "Every figure matches its source.",
      revision: 2,
      at: "2026-09-18T01:00:00.000Z",
    },
  };
  const criteria = ["Names Acme's per-seat price", "Names Globex's per-seat price"];

  it("puts the questions, the open report, sources, screenshots and fact check on one card", () => {
    const [card, ...rest] = researchComments({ research, criteria, acceptedState: "Done" });
    expect(rest).toEqual([]);
    expect(card).toBe(
      [
        "**Research ready for review**",
        [
          "| Question | Result |",
          "| --- | --- |",
          "| Names Acme's per-seat price | ✅ answered (screenshot 1) |",
          "| Names Globex's per-seat price | 👀 not answered |",
        ].join("\n"),
        research.report,
        [
          "**Sources**",
          "",
          "1. [Acme \\[pricing\\]](https://acme.example/pricing), seen 2026-09-18",
          "2. [Globex plans](https://globex.example/plans), seen 2026-09-17",
        ].join("\n"),
        "**Screenshots**",
        "*Screenshot 1: Acme pricing page*\n\n![Acme pricing page](https://uploads.linear.app/acme.png)",
        "*Screenshot 2: Globex plans page* (could not be uploaded)",
        "**Fact check:** Every figure matches its source.",
        "---",
        "To accept, move this issue to Done. To ask for changes, move it back to an earlier state and comment what should change.",
      ].join("\n\n"),
    );
  });

  it("splits a card longer than one comment into numbered comments, the card first", () => {
    const long: AssistantResearch = {
      ...research,
      report: Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: ${"x".repeat(80)}`).join(
        "\n\n",
      ),
    };
    const parts = researchComments({
      research: long,
      criteria,
      acceptedState: "Done",
      maxChars: 1500,
    });
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(1500);
    expect(parts[0]).toMatch(/^\*\*Research ready for review\*\* \(part 1 of \d+\)/);
    expect(parts[0]).toContain("| Names Acme's per-seat price | ✅ answered (screenshot 1) |");
    expect(parts[1]).toMatch(new RegExp(`^\\*\\*Research, part 2 of ${parts.length}\\*\\*`));
    expect(
      parts.slice(0, -1).every((part) => part.endsWith("*Continued in the next comment.*")),
    ).toBe(true);
    // Nothing is lost or repeated: every paragraph is in exactly one part, in order.
    const joined = parts.join("\n");
    for (let i = 1; i <= 40; i++) expect(joined.split(`Paragraph ${i}:`)).toHaveLength(2);
    expect(joined.indexOf("Paragraph 40:")).toBeGreaterThan(joined.indexOf("Paragraph 1:"));
    expect(parts.at(-1)).toContain("To accept, move this issue to Done.");
  });

  it("cuts a single paragraph longer than a comment rather than dropping it", () => {
    const parts = researchComments({
      research: { ...research, report: "Ω".repeat(3000) },
      criteria,
      acceptedState: "Done",
      maxChars: 1200,
    });
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(1200);
    expect(parts.join("").split("Ω").length - 1).toBe(3000);
  });
});

describe("researchShortAnswer", () => {
  it("is the text under the report's opening heading", () => {
    expect(
      researchShortAnswer(
        "# Pricing research\n\n## Short answer\n\n- Acme is cheapest.\n\n## Detail\n\nMore.",
      ),
    ).toBe("- Acme is cheapest.");
  });

  it("is the start of a report with no headings, cut to its limit", () => {
    expect(researchShortAnswer("Acme is cheapest.\n\nGlobex hides its prices.")).toBe(
      "Acme is cheapest.\n\nGlobex hides its prices.",
    );
    expect(researchShortAnswer("z".repeat(50), 10)).toBe(`${"z".repeat(9)}…`);
  });
});
