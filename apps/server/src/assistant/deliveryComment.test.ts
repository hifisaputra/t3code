import { describe, expect, it } from "@effect/vitest";

import { deliveryComment, linearFailureDetail } from "./deliveryComment.ts";

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
    { targetId: "worker", revision: "641c0f8", reference: "deployment 42" },
  ],
};

describe("deliveryComment", () => {
  it("puts the assistant's update above the facts T3 verified", () => {
    const body = deliveryComment({
      comment: "Renewal reminders and the grace period are live on staging.\n",
      deployment,
      pullRequest: { number: 77, url: "https://github.com/Spice-Works/garibet/pull/77" },
    });
    expect(body).toBe(
      [
        "Renewal reminders and the grace period are live on staging.",
        "",
        "---",
        "",
        "**Verified on staging**",
        "",
        "- Staging: [staging.garibet.id](https://staging.garibet.id)",
        "- Pull request: [#77](https://github.com/Spice-Works/garibet/pull/77)",
        "- Verified commit: `641c0f8`",
        "- Deployments: [dashboard](https://github.com/Spice-Works/garibet/actions/runs/34731319248), worker",
      ].join("\n"),
    );
  });

  it("still reports the verified facts when the assistant wrote nothing", () => {
    const body = deliveryComment({
      comment: "  ",
      deployment: { ...deployment, evidence: [] },
      pullRequest: null,
    });
    expect(body).toBe(
      [
        "**Delivered and verified on staging**",
        "",
        "- Staging: [staging.garibet.id](https://staging.garibet.id)",
        "- Verified commit: `641c0f8`",
      ].join("\n"),
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
