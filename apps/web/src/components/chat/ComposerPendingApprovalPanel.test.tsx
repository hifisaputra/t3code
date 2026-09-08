import { ApprovalRequestId, EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerPendingApprovalPanel,
  integrationApprovalPreview,
  integrationApprovalView,
  splitIntegrationDetail,
} from "./ComposerPendingApprovalPanel";

const respondProps = {
  environmentId: EnvironmentId.make("environment-1"),
  isResponding: false,
  onRespondToApproval: () => Promise.resolve(),
};

describe("ComposerPendingApprovalPanel", () => {
  it("keeps the complete command readable in the compact row", () => {
    const detail = `bun run release -- ${"x".repeat(500)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
        {...respondProps}
      />,
    );

    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain('aria-label="Command"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain(detail);
    expect(markup).toContain("max-h-20");
    expect(markup).toContain("overflow-auto");
    expect(markup).toContain("whitespace-pre");
    expect(markup).toContain("[scrollbar-width:thin]");
    expect(markup).toContain("[&amp;::-webkit-scrollbar]:h-1.5");
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("line-clamp");
    expect(markup).toContain("min-w-0");
    expect(markup).not.toContain("Command approval requested");
  });

  it("falls back to the approval kind when the provider sends an empty detail", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-2"),
          requestKind: "file-read",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail: "",
        }}
        pendingCount={1}
        {...respondProps}
      />,
    );

    expect(markup).toContain("File read approval");
  });

  it("shows the app name and message for an MCP access request", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-safari"),
          requestKind: "mcp-elicitation",
          createdAt: "2026-08-24T00:00:00.000Z",
          appName: "Safari",
          detail: "Allow ChatGPT to use Safari?",
        }}
        pendingCount={1}
        {...respondProps}
      />,
    );

    expect(markup).toContain('aria-label="App access approval"');
    expect(markup).toContain('aria-label="App access request"');
    expect(markup).toContain(">Safari<");
    expect(markup).toContain("Allow ChatGPT to use Safari?");
  });

  it("offers the review that carries the change the row cannot fit", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-linear"),
          requestKind: "integration",
          createdAt: "2026-09-08T00:00:00.000Z",
          appName: "Linear",
          detail: "Comment on DEL-177\nComment: Shipped the fix, deploying now.",
          change: {
            summary: "Comment on DEL-177",
            record: { label: "DEL-177", url: "https://linear.app/acme/issue/DEL-177" },
            fields: [
              {
                label: "Comment",
                value: "Shipped the fix, deploying now.",
                format: "markdown" as const,
              },
            ],
          },
        }}
        pendingCount={2}
        {...respondProps}
      />,
    );

    expect(markup).toContain('aria-label="Integration approval"');
    expect(markup).toContain(">Linear<");
    expect(markup).toContain(">Comment on DEL-177<");
    expect(markup).toContain('data-approval-review="open"');
    expect(markup).toContain("1/2");
  });

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

  it("limits long app names so the complete approval message stays readable", () => {
    const appName = "A".repeat(200);
    const detail = "Allow ChatGPT to access the selected application?";
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-long-app-name"),
          requestKind: "mcp-elicitation",
          createdAt: "2026-08-24T00:00:00.000Z",
          appName,
          detail,
        }}
        pendingCount={1}
        {...respondProps}
      />,
    );

    expect(markup).toContain("max-w-32 shrink truncate");
    expect(markup).toContain(appName);
    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain(detail);
  });
});
