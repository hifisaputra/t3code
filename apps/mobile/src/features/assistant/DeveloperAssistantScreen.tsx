import { useNavigation } from "@react-navigation/native";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { AssistantBoard, AssistantTask, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { developerAssistant } from "../../state/developerAssistant";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

function Action({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      className={`rounded-lg bg-surface px-3 py-3 ${disabled ? "opacity-40" : ""}`}
    >
      <Text className="text-sm text-foreground">{title}</Text>
    </Pressable>
  );
}

export function DeveloperAssistantScreen() {
  const { environments } = useEnvironments();
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 p-5 pb-12"
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text className="text-foreground-muted">
        Your assistant manages issue threads. Projects continue after staging deploys; decisions and
        reviews wait here for you.
      </Text>
      {environments.map((environment) => (
        <EnvironmentBoard key={environment.environmentId} environment={environment} />
      ))}
      {!environments.length && (
        <Text className="text-foreground-muted">Connect an environment first.</Text>
      )}
    </ScrollView>
  );
}

function EnvironmentBoard({ environment }: { environment: EnvironmentPresentation }) {
  const environmentId = environment.environmentId;
  const navigation = useNavigation();
  const projects = useProjects();
  const board = useEnvironmentQuery(developerAssistant.board({ environmentId, input: {} }));
  const control = useAtomCommand(developerAssistant.control);
  const answer = useAtomCommand(developerAssistant.answer);
  const review = useAtomCommand(developerAssistant.review);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openThread = (threadId: ThreadId) =>
    navigation.navigate("Thread", { environmentId, threadId });
  const act = async (action: () => Promise<AtomCommandResult<AssistantBoard, unknown>>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-4">
      <Text className="text-lg font-semibold text-foreground">{environment.label}</Text>
      {(error || board.error) && (
        <Text accessibilityRole="alert" className="text-red-500">
          {error ?? board.error}
        </Text>
      )}
      {!board.data?.projects.length && (
        <Text className="text-foreground-muted">
          Set up a project and its models from Developer assistant on web or desktop. You can manage
          it here afterward.
        </Text>
      )}
      {board.data?.projects.map((p) => (
        <View key={p.config.projectId} className="gap-3 rounded-xl border border-border p-4">
          <Text className="font-semibold text-foreground">
            {projects.find((x) => x.environmentId === environmentId && x.id === p.config.projectId)
              ?.title ?? p.config.projectId}{" "}
            · {p.status}
          </Text>
          {p.error && <Text className="text-foreground-muted">{p.error}</Text>}
          <View className="flex-row flex-wrap gap-2">
            <Action title="Conversation" onPress={() => openThread(p.threadId)} />
            <Action
              title={p.status === "running" ? "Stop queue" : "Start"}
              disabled={busy}
              onPress={() =>
                void act(() =>
                  control({
                    environmentId,
                    input: {
                      projectId: p.config.projectId,
                      action: p.status === "running" ? "stop" : "start",
                    },
                  }),
                )
              }
            />
            <Action
              title="Interrupt work"
              disabled={busy}
              onPress={() =>
                void act(() =>
                  control({
                    environmentId,
                    input: { projectId: p.config.projectId, action: "interrupt" },
                  }),
                )
              }
            />
          </View>
        </View>
      ))}
      {board.data?.decisions
        .filter((d) => d.answer === null)
        .map((d) => (
          <View key={d.id} className="gap-3 rounded-xl border border-border p-4">
            <Text className="font-semibold text-foreground">Needs your decision</Text>
            <Text className="text-foreground">{d.question}</Text>
            <Action title="Open thread" onPress={() => openThread(d.threadId)} />
            {d.kind === "decision" ? (
              <>
                <TextInput
                  accessibilityLabel="Your answer"
                  multiline
                  className="min-h-16 rounded-lg border border-border p-3 text-foreground"
                  placeholder="Your answer…"
                  value={answers[d.id] ?? ""}
                  onChangeText={(value) => setAnswers({ ...answers, [d.id]: value })}
                />
                <Action
                  title="Send answer"
                  disabled={busy || !answers[d.id]?.trim()}
                  onPress={() =>
                    void act(() =>
                      answer({
                        environmentId,
                        input: { decisionId: d.id, answer: answers[d.id] ?? "" },
                      }),
                    )
                  }
                />
              </>
            ) : (
              <Text className="text-foreground-muted">
                Answer this question or permission request in its thread.
              </Text>
            )}
          </View>
        ))}
      {board.data?.tasks
        .filter((t) => t.status === "review")
        .map((t) => (
          <MobileReview
            key={t.id}
            task={t}
            busy={busy}
            openThread={openThread}
            onReview={(action, feedback) =>
              void act(() => review({ environmentId, input: { taskId: t.id, action, feedback } }))
            }
          />
        ))}
      {board.data?.tasks
        .filter((t) => ["working", "preparing", "waiting", "blocked"].includes(t.status))
        .map((t) => (
          <View key={t.id} className="gap-2 rounded-xl border border-border p-4">
            <Text className="text-foreground">
              {t.issue.identifier} · {t.issue.title}
            </Text>
            <Text className="text-foreground-muted">
              {t.status}
              {t.error ? `: ${t.error}` : ""}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Action title="Open worker" onPress={() => openThread(t.threadId)} />
              <Action
                title="Retry"
                disabled={busy}
                onPress={() =>
                  void act(() =>
                    review({
                      environmentId,
                      input: {
                        taskId: t.id,
                        action: "retry",
                        feedback: "Please inspect and continue.",
                      },
                    }),
                  )
                }
              />
              <Action
                title="Skip issue"
                disabled={busy}
                onPress={() =>
                  void act(() =>
                    review({
                      environmentId,
                      input: { taskId: t.id, action: "skip", feedback: "Skipped from mobile." },
                    }),
                  )
                }
              />
            </View>
          </View>
        ))}
    </View>
  );
}

function MobileReview({
  task,
  busy,
  openThread,
  onReview,
}: {
  task: AssistantTask;
  busy: boolean;
  openThread: (id: ThreadId) => void;
  onReview: (action: "accept" | "request-changes", feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text className="font-semibold text-foreground">
        Ready for review · {task.issue.identifier}
      </Text>
      <Text className="text-foreground">{task.summary}</Text>
      <Text className="text-foreground-muted">{task.reviewInstructions}</Text>
      <Text className="text-xs text-foreground-muted">
        Verified {task.deployment?.revision.slice(0, 8)} · staging may include later changes
      </Text>
      {task.error && <Text className="text-red-500">{task.error}</Text>}
      <View className="flex-row flex-wrap gap-2">
        {task.deployment && (
          <Action
            title="Open staging"
            onPress={() =>
              void Linking.openURL(task.deployment!.url).catch(() =>
                setError("Could not open staging."),
              )
            }
          />
        )}
        <Action title="Worker thread" onPress={() => openThread(task.threadId)} />
      </View>
      {error && <Text className="text-red-500">{error}</Text>}
      <TextInput
        accessibilityLabel={`Review feedback for ${task.issue.identifier}`}
        multiline
        className="min-h-20 rounded-lg border border-border p-3 text-foreground"
        value={feedback}
        onChangeText={setFeedback}
        placeholder="Feedback or requested changes…"
      />
      <View className="flex-row flex-wrap gap-2">
        <Action title="Accept" disabled={busy} onPress={() => onReview("accept", feedback)} />
        <Action
          title="Request changes"
          disabled={busy || !feedback.trim()}
          onPress={() => onReview("request-changes", feedback)}
        />
      </View>
    </View>
  );
}
