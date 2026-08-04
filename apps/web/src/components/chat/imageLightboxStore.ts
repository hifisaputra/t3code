import { create } from "zustand";

import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ImageLightboxStoreState {
  readonly preview: ExpandedImagePreview | null;
  readonly open: (preview: ExpandedImagePreview | null) => void;
  readonly close: () => void;
}

/**
 * A single app-wide lightbox slot. Composer attachments, timeline attachments, and
 * markdown images in chat all render through the same dialog, so the state lives in
 * a store rather than being threaded through every component that can show an image.
 */
export const useImageLightboxStore = create<ImageLightboxStoreState>()((set) => ({
  preview: null,
  open: (preview) => set({ preview }),
  close: () => set({ preview: null }),
}));

export function openImageLightbox(preview: ExpandedImagePreview | null): void {
  useImageLightboxStore.getState().open(preview);
}

export function closeImageLightbox(): void {
  useImageLightboxStore.getState().close();
}
