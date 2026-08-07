import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

/** Ignore incidental drags; only a deliberate horizontal swipe pages the lightbox. */
const SWIPE_THRESHOLD_PX = 48;

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const index = (preview.index + imageOffset + preview.images.length) % preview.images.length;

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  // Horizontal swipe to page through images — the keyboard arrows are unreachable on
  // the touch devices this UI is regularly used from.
  const swipeStartXRef = useRef<number | null>(null);
  // A swipe that ends on the backdrop still fires a click, which would close the
  // dialog the user was only paging through.
  const swipeHandledRef = useRef(false);
  const onSwipeStart = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    swipeStartXRef.current = event.pointerType === "mouse" ? null : event.clientX;
  }, []);
  const onSwipeEnd = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const startX = swipeStartXRef.current;
      swipeStartXRef.current = null;
      if (startX === null || preview.images.length <= 1) return;
      const distance = event.clientX - startX;
      if (Math.abs(distance) < SWIPE_THRESHOLD_PX) return;
      swipeHandledRef.current = true;
      navigateImage(distance < 0 ? 1 : -1);
    },
    [navigateImage, preview.images.length],
  );
  /** True when this click is the tail of a swipe we already paged on. */
  const consumeSwipe = useCallback(() => {
    if (!swipeHandledRef.current) return false;
    swipeHandledRef.current = false;
    return true;
  }, []);
  const onBackdropClick = useCallback(() => {
    if (consumeSwipe()) return;
    onClose();
  }, [consumeSwipe, onClose]);
  const onTapZoneClick = useCallback(
    (direction: -1 | 1) => {
      if (consumeSwipe()) return;
      navigateImage(direction);
    },
    [consumeSwipe, navigateImage],
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (preview.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, onClose, preview.images.length]);

  const item = preview.images[index];
  if (!item) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
      onPointerDown={onSwipeStart}
      onPointerUp={onSwipeEnd}
      onPointerCancel={() => {
        swipeStartXRef.current = null;
      }}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onBackdropClick}
      />
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <img
          src={item.src}
          alt={item.name}
          className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
          draggable={false}
        />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {item.name}
          {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
        </p>
      </div>
      {preview.images.length > 1 && (
        <>
          {/*
            The arrow buttons are a hard target on a phone, so the outer third of
            each side pages the gallery on tap — including where it overlaps the
            image, which spans nearly the full width on a narrow screen. They sit
            above the image but below the arrows and the close button, which do
            the same thing on click and stay the accessible controls.
          */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="absolute inset-y-0 left-0 z-20 w-1/3 cursor-pointer"
            onClick={() => onTapZoneClick(-1)}
          />
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="absolute inset-y-0 right-0 z-20 w-1/3 cursor-pointer"
            onClick={() => onTapZoneClick(1)}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute left-2 top-1/2 z-30 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
            aria-label="Previous image"
            onClick={() => navigateImage(-1)}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute right-2 top-1/2 z-30 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
            aria-label="Next image"
            onClick={() => navigateImage(1)}
          >
            <ChevronRightIcon className="size-5" />
          </Button>
        </>
      )}
      {/*
        Anchored to the viewport rather than the image corner so the tap zones
        can never cover it.
      */}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute right-2 top-2 z-30 text-white/90 hover:bg-white/10 hover:text-white sm:right-4 sm:top-4"
        onClick={onClose}
        aria-label="Close image preview"
      >
        <XIcon className="size-5" />
      </Button>
    </div>
  );
});
