import { describe, expect, it } from "vite-plus/test";

import {
  integrationApprovalPreview,
  integrationApprovalView,
  splitIntegrationDetail,
} from "./ComposerPendingApprovalPanel.logic";

describe("integration approvals", () => {
  it("reads a structured change field by field", () => {
    const view = integrationApprovalView(
      {
        change: {
          summary: "Update DEL-177",
          record: { label: "DEL-177" },
          fields: [
            { label: "State", value: "In Progress" },
            { label: "Description", value: "Line one\n\nLine two", format: "markdown" as const },
          ],
        },
      },
      "Integration approval",
    );

    expect(view.headline).toBe("Update DEL-177");
    expect(view.preview).toBe("State: In Progress · Description: Line one Line two");
    expect(view.fields).toHaveLength(2);
    expect(view.record?.label).toBe("DEL-177");
  });

  it("falls back to the detail text when a change was never sent", () => {
    const view = integrationApprovalView(
      { detail: "Comment on DEL-1\n\nShipped the fix,\ndeploying now." },
      "Integration approval",
    );

    expect(view.headline).toBe("Comment on DEL-1");
    expect(view.preview).toBe("Shipped the fix, deploying now.");
    // Still reviewable in full: the body becomes the one field the dialog shows.
    expect(view.fields).toEqual([{ label: "Change", value: "Shipped the fix,\ndeploying now." }]);
  });

  it("names the fields of a multi-field preview and lets prose speak alone", () => {
    expect(
      integrationApprovalPreview([
        { label: "Title", value: "Fix login" },
        { label: "State", value: "In Progress" },
      ]),
    ).toBe("Title: Fix login · State: In Progress");
    expect(
      integrationApprovalPreview([
        { label: "Comment", value: "  Shipped   the fix.  ", format: "markdown" },
      ]),
    ).toBe("Shipped the fix.");
    expect(integrationApprovalPreview([])).toBe("");
  });

  it("splits an integration detail into headline and body", () => {
    expect(splitIntegrationDetail("Comment on DEL-1\r\n\r\n## Plan\n\nline two")).toEqual({
      headline: "Comment on DEL-1",
      body: "## Plan\n\nline two",
    });
    expect(splitIntegrationDetail("  Update DEL-2  ")).toEqual({
      headline: "Update DEL-2",
      body: "",
    });
    expect(splitIntegrationDetail("")).toEqual({ headline: "", body: "" });
  });
});
