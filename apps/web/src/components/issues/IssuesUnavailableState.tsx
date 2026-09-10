import { Link } from "@tanstack/react-router";
import { CircleDotIcon, SettingsIcon } from "lucide-react";

import { RefreshIcon } from "~/components/ui/refresh-icon";

import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

/**
 * What the page shows instead of rows when Linear cannot answer: no key on any
 * server, a key Linear rejected, or a request that failed. The caller supplies
 * the sentence, because the server's own message already names the fix.
 */
export function IssuesUnavailableState({
  title = "Could not load issues",
  message,
  onRetry,
  refreshing = false,
  showSettingsLink = false,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  refreshing?: boolean;
  showSettingsLink?: boolean;
}) {
  return (
    <Empty className="px-4 py-16 md:px-4">
      <EmptyMedia variant="icon">
        <CircleDotIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription className="max-w-sm">{message}</EmptyDescription>
      </EmptyHeader>
      {onRetry || showSettingsLink ? (
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          {showSettingsLink ? (
            <Button size="sm" render={<Link to="/settings/integrations" />}>
              <SettingsIcon aria-hidden className="size-3.5" />
              Open Integrations
            </Button>
          ) : null}
          {onRetry ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              <RefreshIcon className="size-3.5" refreshing={refreshing} />
              Retry
            </Button>
          ) : null}
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
