import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";
import { ProviderApprovalOption } from "./providerPolicy.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

const RuntimeTurnState = Schema.Literals(["completed", "failed", "interrupted", "cancelled"]);
export type RuntimeTurnState = typeof RuntimeTurnState.Type;

const RuntimeItemStatus = Schema.Literals(["inProgress", "completed", "failed", "declined"]);
export type RuntimeItemStatus = typeof RuntimeItemStatus.Type;

const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;

export const ToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);
export type ToolLifecycleItemType = typeof ToolLifecycleItemType.Type;

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.includes(value as ToolLifecycleItemType);
}

export const ThreadTokenUsageSnapshot = Schema.Struct({
  usedTokens: NonNegativeInt,
  totalProcessedTokens: Schema.optional(NonNegativeInt),
  maxTokens: Schema.optional(PositiveInt),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  lastUsedTokens: Schema.optional(NonNegativeInt),
  lastInputTokens: Schema.optional(NonNegativeInt),
  lastCachedInputTokens: Schema.optional(NonNegativeInt),
  lastOutputTokens: Schema.optional(NonNegativeInt),
  lastReasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
  compactsAutomatically: Schema.optional(Schema.Boolean),
  autoCompactThreshold: Schema.optional(PositiveInt),
  cost: Schema.optional(
    Schema.Struct({
      amount: Schema.Number.check(Schema.isFinite()),
      currency: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(32)),
    }),
  ),
});
export type ThreadTokenUsageSnapshot = typeof ThreadTokenUsageSnapshot.Type;

// Input includes cache reads/writes; output includes the optional reasoningTokens subset.
const TurnTokenUsageCommonFields = {
  usageScope: Schema.Literal("main_agent"),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  cacheCreationTokens: Schema.optional(NonNegativeInt),
  reasoningTokens: Schema.optional(NonNegativeInt),
  hasSubagents: Schema.Boolean,
};
export const TurnTokenUsage = Schema.Union([
  Schema.Struct({
    ...TurnTokenUsageCommonFields,
    usageStatus: Schema.Literal("complete"),
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt,
  }),
  Schema.Struct({
    ...TurnTokenUsageCommonFields,
    usageStatus: Schema.Literals(["partial", "unavailable"]),
    inputTokens: Schema.optional(NonNegativeInt),
    outputTokens: Schema.optional(NonNegativeInt),
  }),
]);
export type TurnTokenUsage = typeof TurnTokenUsage.Type;

export const ToolActivitySurface = Schema.Literals(["browser", "computer"]);
export type ToolActivitySurface = typeof ToolActivitySurface.Type;

export const ToolActivityNativeAppReference = Schema.Union([
  Schema.TaggedStruct("app-id", {
    appId: TrimmedNonEmptyStringSchema.check(
      Schema.isMaxLength(512),
      Schema.isPattern(/^[A-Za-z0-9._-]+$/u),
    ),
  }),
  Schema.TaggedStruct("display-name", {
    displayName: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(160)),
  }),
]);
export type ToolActivityNativeAppReference = typeof ToolActivityNativeAppReference.Type;

export const ToolActivityIcon = Schema.Union([
  Schema.TaggedStruct("website", {
    pageUrl: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096)),
    faviconUrl: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
    faviconUrlDark: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
  }),
  Schema.TaggedStruct("native-app", {
    app: ToolActivityNativeAppReference,
  }),
  Schema.TaggedStruct("themed-logo", {
    logoUrl: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096)),
    logoUrlDark: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
  }),
]);
export type ToolActivityIcon = typeof ToolActivityIcon.Type;

export const ToolActivitySource = Schema.Struct({
  key: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(512)),
  name: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(160)),
  kind: Schema.Literals(["browser", "computer", "integration"]),
  icon: Schema.optional(ToolActivityIcon),
});
export type ToolActivitySource = typeof ToolActivitySource.Type;

const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  description: Schema.String,
  value: Schema.optional(Schema.String),
});

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  options: Schema.Array(UserInputQuestionOption),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

/**
 * One line of what an integration write will do. `markdown` marks prose the
 * agent wrote — a comment body, an issue description — which the review dialog
 * renders the way the record will, rather than as a quoted blob.
 */
export const IntegrationApprovalChangeField = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  value: Schema.String,
  /**
   * How `value` reads. `image` means it is the workspace-relative path of an
   * image in the thread's workspace: the row shows the path, and the review
   * dialog shows the picture, so the person approves what they can see.
   */
  format: Schema.optional(Schema.Literals(["text", "markdown", "image"])),
});
export type IntegrationApprovalChangeField = typeof IntegrationApprovalChangeField.Type;

/**
 * How long an integration approval card stays answerable.
 *
 * The person answering it may be on a phone, away from the machine, or reading
 * the change in full before deciding, so the window is minutes rather than the
 * seconds a tool call usually takes.
 */
export const INTEGRATION_APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * Everything an integration write will change, whole.
 *
 * `detail` is the sentence the approval row shows and stays short enough for
 * one line; this is what the person reads before approving, so it carries the
 * comment or description in full rather than clipped to a preview.
 */
export const IntegrationApprovalChange = Schema.Struct({
  /** The headline: "Comment on DEL-123", "Update DEL-123", "Create issue in DEL". */
  summary: TrimmedNonEmptyStringSchema,
  /** The record being written to, when it already exists and can be opened. */
  record: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyStringSchema,
      url: Schema.optional(TrimmedNonEmptyStringSchema),
    }),
  ),
  fields: Schema.Array(IntegrationApprovalChangeField),
});
export type IntegrationApprovalChange = typeof IntegrationApprovalChange.Type;

/**
 * Fork: the runtime events `McpApprovalBroker` emits when one of the server's
 * own integration tools asks before writing, consumed by
 * `IntegrationApprovalReactor`. Upstream dropped its provider runtime event
 * union; this is the slice the fork still reaches.
 */
const IntegrationRuntimeEventBase = Schema.Struct({
  eventId: EventId,
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  turnId: Schema.optional(TurnId),
  requestId: Schema.optional(RuntimeRequestId),
});

const IntegrationRequestType = Schema.Literal("integration_write_approval");

const ProviderRuntimeRequestOpenedEvent = Schema.Struct({
  ...IntegrationRuntimeEventBase.fields,
  type: Schema.Literal("request.opened"),
  payload: Schema.Struct({
    requestType: IntegrationRequestType,
    detail: Schema.optional(TrimmedNonEmptyStringSchema),
    appName: Schema.optional(TrimmedNonEmptyStringSchema),
    options: Schema.optional(Schema.Array(ProviderApprovalOption)),
    args: Schema.optional(Schema.Unknown),
    change: Schema.optional(IntegrationApprovalChange),
  }),
});

const ProviderRuntimeRequestResolvedEvent = Schema.Struct({
  ...IntegrationRuntimeEventBase.fields,
  type: Schema.Literal("request.resolved"),
  payload: Schema.Struct({
    requestType: IntegrationRequestType,
    decision: Schema.optional(TrimmedNonEmptyStringSchema),
    resolution: Schema.optional(Schema.Unknown),
  }),
});

export const ProviderRuntimeEvent = Schema.Union([
  ProviderRuntimeRequestOpenedEvent,
  ProviderRuntimeRequestResolvedEvent,
]);
export type ProviderRuntimeEvent = typeof ProviderRuntimeEvent.Type;
