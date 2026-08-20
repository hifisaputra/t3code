import { DiagramLightboxDialog } from "./DiagramLightboxDialog";
import { useDiagramLightboxStore } from "./diagramLightboxStore";

/**
 * Renders the app-wide diagram lightbox. Mounted once at the root, next to the image
 * lightbox, so a diagram shown anywhere opens over the whole window rather than inside
 * the message column it was drawn in.
 */
export function DiagramLightboxHost() {
  const diagram = useDiagramLightboxStore((state) => state.diagram);
  const close = useDiagramLightboxStore((state) => state.close);
  if (!diagram) return null;
  return <DiagramLightboxDialog diagram={diagram} onClose={close} />;
}
