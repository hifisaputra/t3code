import { describe, expect, it } from "@effect/vitest";

import { e2eComment, linearFailureDetail, linearFeedback } from "./linearUpdates.ts";

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
