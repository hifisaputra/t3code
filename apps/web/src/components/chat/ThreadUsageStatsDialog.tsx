import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ThreadId,
  ThreadUsageSlice,
  ThreadUsageStats,
} from "@t3tools/contracts";
import { formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

import { serverEnvironment } from "~/state/server";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/**
 * Input tokens across all three tiers. `reasoningTokens` is deliberately absent:
 * providers fold it inside `outputTokens`, so adding it would double count.
 */
function inputTokens(totals: ThreadUsageStats["total"]["totals"]): number {
  return totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens;
}

function Row(props: {
  readonly label: string;
  readonly sublabel?: string | undefined;
  readonly costUsd: number;
  readonly tokens: number;
  readonly share: number | null;
  readonly emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div
          className={
            props.emphasis ? "truncate text-sm font-medium" : "truncate text-sm text-foreground/80"
          }
        >
          {props.label}
        </div>
        {props.sublabel ? (
          <div className="truncate text-xs text-muted-foreground">{props.sublabel}</div>
        ) : null}
      </div>
      <div className="shrink-0 text-right tabular-nums">
        <div className={props.emphasis ? "text-sm font-medium" : "text-sm"}>
          {formatUsd(props.costUsd)}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatTokens(props.tokens)}
          {props.share === null ? "" : ` · ${formatPercent(props.share)}`}
        </div>
      </div>
    </div>
  );
}

function sliceTokens(slice: ThreadUsageSlice): number {
  return inputTokens(slice.totals) + slice.totals.outputTokens;
}

function StatsBody({ stats }: { readonly stats: ThreadUsageStats }) {
  if (stats.source === "unavailable") {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        {stats.incompleteReason ?? "No usage has been recorded for this thread."}
      </p>
    );
  }

  const totalCost = stats.total.costUsd;
  const share = (cost: number) => (totalCost > 0 ? cost / totalCost : null);
  const totalTokens = inputTokens(stats.total.totals) + stats.total.totals.outputTokens;
  const hasSubagents = stats.subagents.records > 0;

  return (
    <div className="divide-y divide-border/60">
      <div className="pb-1">
        <Row
          label="Total"
          costUsd={totalCost}
          tokens={totalTokens}
          share={null}
          emphasis
          sublabel={`${formatTokens(inputTokens(stats.total.totals))} in · ${formatTokens(stats.total.totals.outputTokens)} out`}
        />
      </div>

      <div className="py-1">
        <Row
          label="Main agent"
          costUsd={stats.mainAgent.costUsd}
          tokens={inputTokens(stats.mainAgent.totals) + stats.mainAgent.totals.outputTokens}
          share={share(stats.mainAgent.costUsd)}
        />
        {stats.mainAgentByModel.length > 1
          ? stats.mainAgentByModel.map((slice) => (
              <div className="pl-3" key={`main:${slice.model}`}>
                <Row
                  label={slice.model}
                  costUsd={slice.costUsd}
                  tokens={sliceTokens(slice)}
                  share={share(slice.costUsd)}
                />
              </div>
            ))
          : null}
      </div>

      {hasSubagents ? (
        <div className="py-1">
          <Row
            label="Subagents"
            costUsd={stats.subagents.costUsd}
            tokens={inputTokens(stats.subagents.totals) + stats.subagents.totals.outputTokens}
            share={share(stats.subagents.costUsd)}
          />
          {stats.subagentBreakdown.map((slice) => (
            <div className="pl-3" key={`sub:${slice.agentName ?? ""}:${slice.model}`}>
              <Row
                label={slice.agentName ?? "Unnamed subagent"}
                sublabel={slice.model}
                costUsd={slice.costUsd}
                tokens={sliceTokens(slice)}
                share={share(slice.costUsd)}
              />
            </div>
          ))}
        </div>
      ) : null}

      {stats.total.cacheSavingsUsd > 0 ? (
        <p className="pt-2 text-xs text-muted-foreground">
          Prompt caching saved {formatUsd(stats.total.cacheSavingsUsd)} against uncached input
          rates.
        </p>
      ) : null}
      {stats.total.unpricedRecords > 0 ? (
        <p className="pt-2 text-xs text-muted-foreground">
          {stats.total.unpricedRecords} response
          {stats.total.unpricedRecords === 1 ? "" : "s"} had no published rate, so their tokens are
          counted but not costed.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One thread's tokens and cost, including work it delegated to subagents.
 *
 * Cost is what these tokens would bill at published API rates. It is not money
 * spent — a subscription bills separately — and the copy says so rather than
 * letting the figure be read as an invoice.
 */
export function ThreadUsageStatsDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Usage stats</DialogTitle>
          <DialogDescription>
            What this thread&rsquo;s tokens would cost at published API rates, including its
            subagents. Not a bill.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.open ? (
            <ThreadUsageStatsContent
              environmentId={props.environmentId}
              threadId={props.threadId}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Split out so the query only mounts while the dialog is open: reading a
 * thread's transcripts is real file work and must not run for every row.
 */
function ThreadUsageStatsContent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const result = useAtomValue(
    serverEnvironment.threadUsageStats({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );

  if (result._tag === "Failure") {
    return <p className="py-2 text-sm text-muted-foreground">Usage could not be read.</p>;
  }
  if (result._tag !== "Success") {
    return (
      // Static placeholders: a pulsing skeleton repaints continuously, which is
      // exactly what the performance rules ask surfaces not to do.
      <div className="space-y-2 py-2" aria-busy="true" aria-label="Loading usage stats">
        <div className="h-4 w-full rounded bg-muted/60" />
        <div className="h-4 w-2/3 rounded bg-muted/60" />
      </div>
    );
  }
  return <StatsBody stats={result.value} />;
}
