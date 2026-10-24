import type { EnvironmentId } from "@t3tools/contracts";
import { Download } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { base64ToBytes } from "~/lib/base64";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

/** Hands the bytes to the browser as a file download. Module scope: the compiler skips try/finally. */
function saveDownload(fileName: string, contentsBase64: string) {
  const url = URL.createObjectURL(new Blob([base64ToBytes(contentsBase64)]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Give the browser time to start consuming the download before releasing its bytes.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export function FileDownloadButton({
  environmentId,
  cwd,
  relativePath,
  showLabel = false,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string | null;
  showLabel?: boolean;
}) {
  const readFile = useAtomCommand(projectEnvironment.readFileForDownload);
  const pendingRef = useRef(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const label = relativePath
    ? `Download ${relativePath.split("/").at(-1)}`
    : "Select a file to download";

  const handleDownload = async () => {
    if (!relativePath || pendingRef.current) return;
    pendingRef.current = true;
    setIsDownloading(true);
    const fileName = relativePath.split("/").at(-1) ?? relativePath;
    const download = async () => {
      const result = await readFile({
        environmentId,
        input: { cwd, relativePath, encoding: "base64" },
      });
      if (result._tag !== "Success") {
        throw new Error(`Could not download ${fileName}.`);
      }
      if (result.value.truncated) {
        throw new Error(`${fileName} is too large to download (over 50MB).`);
      }
      saveDownload(fileName, result.value.contents);
    };
    await download()
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Download failed",
          description: error instanceof Error ? error.message : `Could not download ${fileName}.`,
        });
      })
      .finally(() => {
        pendingRef.current = false;
        setIsDownloading(false);
      });
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size={showLabel ? "sm" : "icon-sm"}
            className="shrink-0"
            aria-label={label}
            aria-busy={isDownloading}
            disabled={!relativePath || isDownloading}
            onClick={() => void handleDownload()}
          />
        }
      >
        <Download className="size-3.5" />
        {showLabel ? (isDownloading ? "Downloading…" : "Download") : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
