import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import type { ThreadIssuePresentation } from "../../state/thread-issue-presentation";

/**
 * The linked Linear issue as a pill: workflow-state dot plus the identifier.
 * Sits beside the pull request chip in the thread lists, and opens the issue
 * in Linear on tap. The dot takes Linear's own state colour, so it falls back
 * to the row's muted foreground until the issue loads.
 */
export function ThreadIssueChip(props: {
  readonly issue: ThreadIssuePresentation;
  /** Phone-sized rows use the larger text, sidebar rows the smaller. */
  readonly compact?: boolean;
  /** The row is the selected one, so the chip inherits its foreground. */
  readonly selected?: boolean;
}) {
  const selected = props.selected === true;
  const color = props.issue.color;

  return (
    <Pressable
      accessibilityHint="Opens the issue in Linear"
      accessibilityLabel={props.issue.accessibilityLabel}
      accessibilityRole="link"
      className="flex-row items-center gap-1 active:opacity-60"
      hitSlop={8}
      onPress={() => {
        void tryOpenExternalUrl(props.issue.url, "linear-issue").then((opened) => {
          if (!opened) Alert.alert("Unable to open issue", "The Linear issue could not be opened.");
        });
      }}
    >
      <View
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          color === null && (selected ? "bg-user-bubble-foreground-muted" : "bg-foreground-muted"),
        )}
        style={color === null ? undefined : { backgroundColor: color }}
      />
      <Text
        className={cn(
          props.compact === true ? "text-sm" : "text-xs",
          "font-t3-medium",
          selected ? "text-user-bubble-foreground" : "text-foreground-muted",
        )}
        numberOfLines={1}
      >
        {props.issue.identifier}
      </Text>
    </Pressable>
  );
}
