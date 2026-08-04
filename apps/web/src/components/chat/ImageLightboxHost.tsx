import { ExpandedImageDialog } from "./ExpandedImageDialog";
import { useImageLightboxStore } from "./imageLightboxStore";

/**
 * Renders the app-wide image lightbox. Mounted once at the root so images shown
 * outside the chat view (plan sidebar, file preview) can open it too.
 */
export function ImageLightboxHost() {
  const preview = useImageLightboxStore((state) => state.preview);
  const close = useImageLightboxStore((state) => state.close);
  if (!preview) return null;
  return (
    <ExpandedImageDialog
      key={`${preview.images[preview.index]?.src ?? "image"}:${preview.index}`}
      preview={preview}
      onClose={close}
    />
  );
}
