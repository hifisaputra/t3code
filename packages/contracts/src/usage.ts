import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Bumped whenever the shape of {@link UsageSummary} changes incompatibly.
 * Adding providers or other array-element variants is additive: unknown entries
 * are skipped on decode and do not require a version bump.
 */
export const USAGE_CONTRACT_VERSION = 6 as const;

export const USAGE_MERGE_COMPATIBLE_SINCE = 4 as const;

export const UsageProviderKind = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

export const UsageResolution = Schema.Literals(["day", "hour"]);
export type UsageResolution = typeof UsageResolution.Type;

export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/**
 * `cachedInputTokens` and `cacheCreationTokens` are disjoint from
 * `uncachedInputTokens`; summing all three gives total input. `reasoningTokens`
 * is a *subset* of `outputTokens` (Codex reports it that way, and Anthropic
 * folds thinking into output), so it must never be added on top.
 */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

export const UsageCategoryCost = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
});
export type UsageCategoryCost = typeof UsageCategoryCost.Type;

export const UsageBucket = Schema.Struct({
  day: UsageDay,
  hourStart: Schema.optional(TrimmedNonEmptyString),
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  sourcePath: Schema.optional(TrimmedNonEmptyString),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  categoryCostUsd: Schema.optional(UsageCategoryCost),
  fastCostUsd: Schema.optional(Schema.Number),
  ultrafastCostUsd: Schema.optional(Schema.Number),
  speedPremiumUsd: Schema.optional(Schema.Number),
  costSource: UsageCostSource,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  sessions: NonNegativeInt,
});
export type UsageBucket = typeof UsageBucket.Type;

export const UsageSourceFingerprint = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  resolvedHomePath: TrimmedNonEmptyString,
  /**
   * Filesystem identity of the transcript directory, as `device:inode`.
   * Hostname and path alone are not enough: every Mac in a fleet resolves
   * `/Users/<user>/.claude`, so two machines that happen to share a hostname
   * would look like one source and have their usage silently dropped.
   */
  volumeId: Schema.String,
});
export type UsageSourceFingerprint = typeof UsageSourceFingerprint.Type;

export const UsageSourceStatus = Schema.Literals(["ok", "missing", "partial", "failed"]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSource = Schema.Struct({
  fingerprint: UsageSourceFingerprint,
  status: UsageSourceStatus,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  malformedRecords: NonNegativeInt,
  /**
   * Buckets also carry per-bucket session counts, but a session spans days and
   * models, so summing those overcounts; this is the figure clients should
   * total.
   */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
  action: Schema.optionalKey(Schema.Literal("enableCursorKeychain")),
  /**
   * Present when this source answered from its cache while a slow refresh (an
   * account API, for example) runs. Repeat the request with `awaitRefresh` to
   * get the refreshed source.
   */
  refreshing: Schema.optionalKey(Schema.Literal(true)),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

export const UsageSummaryInput = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  /**
   * IANA zone the client wants days bucketed in. An offset would be wrong for
   * any window that crosses a DST boundary.
   */
  timeZone: TrimmedNonEmptyString,
  resolution: Schema.optional(UsageResolution),
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  untilTime: Schema.optional(TrimmedNonEmptyString),
  awaitRefresh: Schema.optional(Schema.Boolean),
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: ForwardCompatibleArray(UsageBucket),
  sources: ForwardCompatibleArray(UsageSource),
  pricing: UsagePricing,
  scanDurationMs: NonNegativeInt,
});
export type UsageSummary = typeof UsageSummary.Type;

export class UsageReadError extends Schema.TaggedError<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}

/**
 * Where a thread's figures came from.
 *
 * `recorded` is usage T3 Code captured as the turns ran and keeps for the life
 * of the thread. `transcript` is read back from the provider CLI's own session
 * files, which are exact but only while the provider keeps them — Claude prunes
 * old transcripts, so an old thread reports `unavailable` rather than zero.
 */
export const ThreadUsageSource = Schema.Literals(["recorded", "transcript", "unavailable"]);
export type ThreadUsageSource = typeof ThreadUsageSource.Type;

export const ThreadUsageTotals = Schema.Struct({
  totals: UsageTokenTotals,
  /** API-equivalent cost of these tokens, not money billed. See {@link UsageBucket}. */
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  /** Distinct assistant responses, after de-duplication. */
  records: NonNegativeInt,
  /** Responses whose tokens are counted but which no rate could price. */
  unpricedRecords: NonNegativeInt,
});
export type ThreadUsageTotals = typeof ThreadUsageTotals.Type;

/** One `(agent, model)` row. */
export const ThreadUsageSlice = Schema.Struct({
  /**
   * Subagent name, or `null` both for the main agent and for a subagent the
   * provider ran without naming one. Which it is follows from the field the
   * slice arrived in, never from this value.
   */
  agentName: Schema.NullOr(TrimmedNonEmptyString),
  model: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
});
export type ThreadUsageSlice = typeof ThreadUsageSlice.Type;

/**
 * One thread's token and cost breakdown, including everything it delegated to
 * subagents.
 *
 * Subagent work is counted because the provider stamps a subagent's records
 * with its parent session, so delegated spend lands on the thread that caused
 * it rather than vanishing.
 */
export const ThreadUsageStats = Schema.Struct({
  threadId: ThreadId,
  source: ThreadUsageSource,
  /** Main agent plus every subagent. */
  total: ThreadUsageTotals,
  /** The thread's own agent, excluding delegated work. */
  mainAgent: ThreadUsageTotals,
  /** Everything delegated to subagents. */
  subagents: ThreadUsageTotals,
  /** Main-agent usage by model, largest cost first. */
  mainAgentByModel: Schema.Array(ThreadUsageSlice),
  /** Subagent usage by `(agent, model)`, largest cost first. */
  subagentBreakdown: Schema.Array(ThreadUsageSlice),
  firstRecordAt: Schema.NullOr(Schema.String),
  lastRecordAt: Schema.NullOr(Schema.String),
  pricing: UsagePricing,
  /**
   * Set when the figures are known to be short — a provider whose subagents are
   * not yet attributable, or a thread whose transcripts were partly pruned. The
   * UI shows it rather than presenting an incomplete total as exact.
   */
  incompleteReason: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadUsageStats = typeof ThreadUsageStats.Type;

export const ThreadUsageStatsInput = Schema.Struct({ threadId: ThreadId });
export type ThreadUsageStatsInput = typeof ThreadUsageStatsInput.Type;
