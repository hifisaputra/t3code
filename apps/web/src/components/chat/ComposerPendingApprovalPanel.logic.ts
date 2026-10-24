import type { IntegrationApprovalChangeField } from "@t3tools/contracts";

import type { PendingApproval } from "../../session-logic";

/**
 * An integration write arrives as "what" on the first line and the content it
 * will send after a blank line, so the two are shown as a headline and a body
 * rather than one preformatted block the row cannot wrap.
 */
export function splitIntegrationDetail(detail: string): {
  readonly headline: string;
  readonly body: string;
} {
  const normalized = detail.replace(/\r\n/g, "\n").trim();
  const [headline = "", ...rest] = normalized.split("\n");
  return { headline: headline.trim(), body: rest.join("\n").trim() };
}

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * What an integration approval is asking for, in the two shapes it comes in.
 *
 * The server's own integration tools send the change structured, field by
 * field. A row persisted before that existed carries only the detail text,
 * whose first line is the headline and whose remainder reads as one block.
 * Both end up as fields so the row and the review dialog have one thing to
 * render.
 */
export function integrationApprovalView(
  approval: Pick<PendingApproval, "change" | "detail">,
  fallbackHeadline: string,
): {
  readonly headline: string;
  readonly preview: string;
  readonly record: { readonly label: string; readonly url?: string | undefined } | undefined;
  readonly fields: ReadonlyArray<IntegrationApprovalChangeField>;
} {
  const change = approval.change;
  if (change) {
    return {
      headline: change.summary,
      preview: integrationApprovalPreview(change.fields),
      record: change.record,
      fields: change.fields,
    };
  }
  const { headline, body } = splitIntegrationDetail(approval.detail ?? "");
  const fields = body ? [{ label: "Change", value: body } as const] : [];
  return {
    headline: headline || fallbackHeadline,
    preview: collapseWhitespace(body),
    record: undefined,
    fields,
  };
}

/**
 * The row's one line about the change. Prose the agent wrote stands on its own;
 * a set of edited fields reads better as `Title: … · State: …`, since a bare
 * value there says nothing about what it is going to become.
 */
export function integrationApprovalPreview(
  fields: ReadonlyArray<IntegrationApprovalChangeField>,
): string {
  const [first] = fields;
  if (first === undefined) return "";
  if (fields.length === 1) return collapseWhitespace(first.value);
  return fields.map((field) => `${field.label}: ${collapseWhitespace(field.value)}`).join(" · ");
}
