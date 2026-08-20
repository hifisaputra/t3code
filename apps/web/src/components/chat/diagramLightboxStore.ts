import { create } from "zustand";

export interface ExpandedDiagram {
  /** The SVG Mermaid drew for the fence, reused as-is so the lightbox never re-renders it. */
  readonly svg: string;
  /** The fence source, so a copied lightbox still carries the diagram back out as markdown. */
  readonly code: string;
}

interface DiagramLightboxStoreState {
  readonly diagram: ExpandedDiagram | null;
  readonly open: (diagram: ExpandedDiagram) => void;
  readonly close: () => void;
}

/**
 * A single app-wide slot for the expanded diagram, matching the image lightbox: the
 * dialog is mounted once at the root, and any diagram anywhere in the app opens it
 * without threading state through the message tree.
 */
export const useDiagramLightboxStore = create<DiagramLightboxStoreState>()((set) => ({
  diagram: null,
  open: (diagram) => set({ diagram }),
  close: () => set({ diagram: null }),
}));

export function openDiagramLightbox(diagram: ExpandedDiagram): void {
  useDiagramLightboxStore.getState().open(diagram);
}

export function closeDiagramLightbox(): void {
  useDiagramLightboxStore.getState().close();
}
