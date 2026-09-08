import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerPendingApprovalPanel,
  splitIntegrationDetail,
} from "./ComposerPendingApprovalPanel";

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
      />,
    );

    expect(markup).toContain('aria-label="App access approval"');
    expect(markup).toContain('aria-label="App access request"');
    expect(markup).toContain(">Safari<");
    expect(markup).toContain("Allow ChatGPT to use Safari?");
  });

  it("labels an integration write request with its app name and multi-line detail", () => {
    const detail = "Comment on DEL-177\n\nShipped the fix, deploying now.";
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-linear"),
          requestKind: "integration",
          createdAt: "2026-09-08T00:00:00.000Z",
          appName: "Linear",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('aria-label="Integration approval"');
    expect(markup).toContain('aria-label="Requested change"');
    expect(markup).toContain(">Linear<");
    expect(markup).toContain(">Comment on DEL-177<");
    expect(markup).toContain("Shipped the fix, deploying now.");
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain("break-words");
    expect(markup).not.toContain("font-mono");
  });

  it("shows only the headline when an integration write has no body", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-linear-update"),
          requestKind: "integration",
          createdAt: "2026-09-08T00:00:00.000Z",
          appName: "Linear",
          detail: "Update DEL-177",
        }}
        pendingCount={2}
      />,
    );

    expect(markup).toContain(">Update DEL-177<");
    expect(markup).not.toContain('data-approval-detail="complete"');
    expect(markup).toContain("1/2");
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
      />,
    );

    expect(markup).toContain("max-w-32 shrink truncate");
    expect(markup).toContain(appName);
    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain(detail);
  });
});
