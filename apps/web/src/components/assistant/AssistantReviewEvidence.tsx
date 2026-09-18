import type {
  AssistantE2eCheckResult,
  AssistantResearchCheckResult,
  AssistantTask,
  EnvironmentId,
} from "@t3tools/contracts";
import { CheckIcon, CircleIcon, FilmIcon, ImageIcon, MinusIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { Checkbox } from "../ui/checkbox";
import { ExpandableMarkdown } from "./assistantUi";
import { useAssistantEvidenceUrls } from "./assistantScreenshots";

const CHECK_RESULT: Record<
  AssistantE2eCheckResult | AssistantResearchCheckResult,
  { icon: typeof CheckIcon; label: string; className: string }
> = {
  answered: { icon: CheckIcon, label: "Answered", className: "text-success-foreground" },
  partly: { icon: MinusIcon, label: "Partly answered", className: "text-warning-foreground" },
  "not-answered": { icon: CircleIcon, label: "Not answered", className: "text-warning-foreground" },
  passed: { icon: CheckIcon, label: "Passed", className: "text-success-foreground" },
  failed: { icon: XIcon, label: "Failed", className: "text-destructive-foreground" },
  "not-checked": { icon: CircleIcon, label: "Not checked", className: "text-warning-foreground" },
  skipped: { icon: MinusIcon, label: "Not in smoke test", className: "text-muted-foreground" },
};

/** A small uppercase heading over one part of the evidence, with an optional count. */
export function EvidenceHeading({ children, count }: { children: ReactNode; count?: ReactNode }) {
  return (
    <p className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
      {children}
      {count !== undefined ? <span className="normal-case"> · {count}</span> : null}
    </p>
  );
}

const EMPTY_FILES: ReadonlyArray<never> = [];

/**
 * The task's e2e screenshots and recordings and the lightbox that shows them.
 * Criteria rows and the evidence sections share one, so "screenshot 2" and the
 * second tile open the same image, and "video 1" plays the first recording.
 * Files with no inline address link to the Linear issue instead.
 */
export function useScreenshotViewer(environmentId: EnvironmentId, task: AssistantTask) {
  const shots =
    (task.track === "research" ? task.research?.screenshots : task.e2e?.screenshots) ?? EMPTY_FILES;
  const videos = (task.track === "research" ? undefined : task.e2e?.videos) ?? EMPTY_FILES;
  const urls = useAssistantEvidenceUrls(environmentId, task.threadId, shots);
  const videoUrls = useAssistantEvidenceUrls(environmentId, task.threadId, videos);
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const viewable = shots.flatMap((shot, index) => {
    const src = urls[index];
    return src ? [{ index, src, name: shot.caption || `Screenshot ${index + 1}` }] : [];
  });
  const open = (index: number) => {
    const position = viewable.findIndex((entry) => entry.index === index);
    if (position < 0) return;
    setPreview({
      images: viewable.map(({ src, name }) => ({ src, name })),
      index: position,
    });
  };
  const playable = videos.flatMap((video, index) => {
    const src = videoUrls[index];
    return src ? [{ index, src, name: video.caption || `Recording ${index + 1}` }] : [];
  });
  const openVideo = (index: number) => {
    const position = playable.findIndex((entry) => entry.index === index);
    if (position < 0) return;
    setPreview({
      images: playable.map(({ src, name }) => ({ src, name, type: "video" as const })),
      index: position,
    });
  };
  return {
    shots,
    urls,
    videos,
    videoUrls,
    issueUrl: task.issue.url,
    open,
    openVideo,
    dialog: preview ? (
      <ExpandedImageDialog
        key={`${preview.index}`}
        preview={preview}
        onClose={() => setPreview(null)}
      />
    ) : null,
  };
}

export type ScreenshotViewer = ReturnType<typeof useScreenshotViewer>;

/**
 * "screenshot N" or "video N": opens the file in the lightbox, or the issue
 * when it cannot be shown here.
 */
function EvidenceLink({
  viewer,
  kind,
  index,
}: {
  viewer: ScreenshotViewer;
  kind: "screenshot" | "video";
  index: number;
}) {
  const className =
    "inline-flex shrink-0 items-center gap-1 text-muted-foreground text-xs hover:text-foreground hover:underline";
  const Icon = kind === "video" ? FilmIcon : ImageIcon;
  const label = (
    <>
      <Icon aria-hidden className="size-3" />
      {kind} {index + 1}
    </>
  );
  const url = kind === "video" ? viewer.videoUrls[index] : viewer.urls[index];
  const open = kind === "video" ? viewer.openVideo : viewer.open;
  return url ? (
    <button type="button" onClick={() => open(index)} className={className}>
      {label}
    </button>
  ) : (
    <a href={viewer.issueUrl} target="_blank" rel="noreferrer" className={className}>
      {label}
    </a>
  );
}

/** A tester's evidence, clamped to two lines until clicked when it runs long. */
function Evidence({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160 || text.includes("\n");
  if (!long) return <p className="text-muted-foreground text-xs">{text}</p>;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      className={cn(
        "block w-full whitespace-pre-line text-left text-muted-foreground text-xs hover:text-foreground",
        !open && "line-clamp-2",
      )}
    >
      {text}
    </button>
  );
}

/**
 * The issue's acceptance criteria in their numbered order, each with the
 * tester's result, evidence, screenshot and recording once the e2e run reports them.
 * Results for criteria that were never recorded fall back to their number.
 */
export function CriteriaResults({
  task,
  viewer,
}: {
  task: AssistantTask;
  viewer: ScreenshotViewer;
}) {
  const criteria = task.criteria ?? [];
  const checks = (task.track === "research" ? task.research?.checks : task.e2e?.checks) ?? [];
  const count = Math.max(criteria.length, ...checks.map((check) => check.criterion));
  if (count <= 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {Array.from({ length: count }, (_, index) => {
        const check = checks.find((entry) => entry.criterion === index + 1) ?? null;
        const result = check ? CHECK_RESULT[check.result] : null;
        const shot = check?.screenshot ? check.screenshot - 1 : null;
        const video = check && "video" in check && check.video ? check.video - 1 : null;
        return (
          // The position is the criterion's identity: results index into it.
          <li key={index} className="flex min-w-0 items-start gap-2">
            {result ? (
              <result.icon
                aria-label={result.label}
                className={cn("mt-0.5 size-3.5 shrink-0", result.className)}
              />
            ) : (
              <span className="w-3.5 shrink-0 text-right text-muted-foreground text-xs tabular-nums leading-5">
                {index + 1}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className={cn(check?.result === "skipped" && "text-muted-foreground")}>
                {criteria[index] ?? `Criterion ${index + 1}`}
              </p>
              {task.track === "research" && result ? (
                <p className={cn("text-xs", result.className)}>{result.label}</p>
              ) : null}
              {check?.evidence.trim() ? <Evidence text={check.evidence.trim()} /> : null}
            </div>
            {shot !== null && shot < viewer.shots.length ? (
              <EvidenceLink viewer={viewer} kind="screenshot" index={shot} />
            ) : null}
            {video !== null && video < viewer.videos.length ? (
              <EvidenceLink viewer={viewer} kind="video" index={video} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The e2e screenshots as thumbnails that open the lightbox, or links to Linear. */
export function ScreenshotGrid({ viewer }: { viewer: ScreenshotViewer }) {
  if (viewer.shots.length === 0) return null;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {viewer.shots.map((shot, index) => {
        const src = viewer.urls[index];
        const caption = shot.caption || `Screenshot ${index + 1}`;
        return (
          // oxlint-disable-next-line react/no-array-index-key
          <li key={index} className="min-w-0">
            {src ? (
              <button
                type="button"
                onClick={() => viewer.open(index)}
                className="group flex w-full min-w-0 flex-col gap-1 text-left focus-visible:outline-none"
              >
                <img
                  src={src}
                  alt={caption}
                  loading="lazy"
                  decoding="async"
                  className="aspect-video w-full rounded-md border border-border/70 bg-muted/40 object-cover object-top group-hover:border-border group-focus-visible:ring-1 group-focus-visible:ring-ring"
                />
                <span className="truncate text-muted-foreground text-xs group-hover:text-foreground">
                  {caption}
                </span>
              </button>
            ) : (
              <a
                href={viewer.issueUrl}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 px-2 py-1.5 text-muted-foreground text-xs hover:bg-accent/40 hover:text-foreground"
              >
                <ImageIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="shrink-0">Screenshot {index + 1}</span>
                {shot.caption ? <span className="min-w-0 truncate">· {shot.caption}</span> : null}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The e2e recordings as inline players that load only their metadata until
 * played, or links to Linear when a clip cannot be served here.
 */
export function RecordingList({ viewer }: { viewer: ScreenshotViewer }) {
  if (viewer.videos.length === 0) return null;
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {viewer.videos.map((video, index) => {
        const src = viewer.videoUrls[index];
        const caption = video.caption || `Recording ${index + 1}`;
        return (
          // oxlint-disable-next-line react/no-array-index-key
          <li key={index} className="flex min-w-0 flex-col gap-1">
            {src ? (
              <>
                <MediaVideoPlayer
                  src={src}
                  label={caption}
                  originalUrl={viewer.issueUrl}
                  preload="metadata"
                  className="w-full"
                  videoClassName="rounded-md border border-border/70"
                />
                <span className="truncate text-muted-foreground text-xs">{caption}</span>
              </>
            ) : (
              <a
                href={viewer.issueUrl}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 px-2 py-1.5 text-muted-foreground text-xs hover:bg-accent/40 hover:text-foreground"
              >
                <FilmIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="shrink-0">Recording {index + 1}</span>
                {video.caption ? <span className="min-w-0 truncate">· {video.caption}</span> : null}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A plain list of the tester's notes, such as checks left for the person or things worth a look. */
export function EvidenceNotes({ items }: { items: ReadonlyArray<string> }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground text-sm">
      {items.map((item, index) => (
        // oxlint-disable-next-line react/no-array-index-key
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * What the tester left for the person to check before accepting, as a
 * checklist. Ticks are the person's own notes: they never gate accepting.
 */
export function HumanChecklist({
  checks,
  ticked,
  onTick,
}: {
  checks: ReadonlyArray<string>;
  ticked: ReadonlySet<number>;
  onTick: (index: number, checked: boolean) => void;
}) {
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {checks.map((check, index) => (
        // oxlint-disable-next-line react/no-array-index-key
        <li key={index}>
          <label className="flex cursor-pointer items-start gap-2">
            <Checkbox
              className="mt-0.5"
              checked={ticked.has(index)}
              onCheckedChange={(checked) => onTick(index, checked)}
            />
            <span className={cn(ticked.has(index) && "text-muted-foreground line-through")}>
              {check}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** The report remains available in both the review inbox and the issue's history. */
export function ResearchEvidence({
  task,
  environmentId,
  viewer,
}: {
  task: AssistantTask;
  environmentId: EnvironmentId;
  viewer: ScreenshotViewer;
}) {
  const research = task.research;
  const [reportOpen, setReportOpen] = useState(false);
  if (!research)
    return <p className="text-muted-foreground text-sm">No research report submitted yet.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {task.summary.trim() ? (
        <ExpandableMarkdown
          text={task.summary}
          environmentId={environmentId}
          collapsedClassName="max-h-28"
        />
      ) : null}
      <section>
        <button
          type="button"
          aria-expanded={reportOpen}
          onClick={() => setReportOpen(!reportOpen)}
          className="font-medium text-sm hover:underline"
        >
          {reportOpen ? "Hide full report" : "Read full report"}
        </button>
        {reportOpen ? (
          <div className="mt-2">
            <ChatMarkdown
              text={research.report}
              cwd={undefined}
              environmentId={environmentId}
              className="text-sm [&_p]:leading-relaxed"
            />
          </div>
        ) : null}
      </section>
      <section>
        <EvidenceHeading>Research questions</EvidenceHeading>
        <CriteriaResults task={task} viewer={viewer} />
      </section>
      <section>
        <EvidenceHeading count={research.sources.length}>Sources</EvidenceHeading>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
          {research.sources.map((source, index) => (
            // Sources are numbered by position in the report, including repeated URLs.
            // oxlint-disable-next-line react/no-array-index-key
            <li key={`${index}:${source.url}`}>
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="break-words underline underline-offset-2"
              >
                {source.title}
              </a>
              <span className="text-muted-foreground text-xs"> · Seen {source.seen}</span>
            </li>
          ))}
        </ol>
      </section>
      {viewer.shots.length ? (
        <section>
          <EvidenceHeading count={viewer.shots.length}>Screenshots</EvidenceHeading>
          <ScreenshotGrid viewer={viewer} />
        </section>
      ) : null}
      {research.review && research.review.revision === research.revision ? (
        <section>
          <EvidenceHeading>
            Fact check · {research.review.verdict === "approved" ? "Approved" : "Changes requested"}
          </EvidenceHeading>
          <ExpandableMarkdown text={research.review.summary} environmentId={environmentId} />
          {research.review.findings.length ? (
            <ExpandableMarkdown text={research.review.findings} environmentId={environmentId} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
