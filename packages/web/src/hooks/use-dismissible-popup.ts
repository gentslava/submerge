import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  chooseFloatingMenuPlacement,
  type FloatingMenuPlacement,
  visibleBoundaryTop,
} from "@/lib/floating-menu";

interface UseDismissiblePopupOptions {
  preferredPlacement: FloatingMenuPlacement;
}

export function useDismissiblePopup({ preferredPlacement }: UseDismissiblePopupOptions) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<FloatingMenuPlacement>(preferredPlacement);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const toggle = useCallback(() => setOpen((current) => !current), []);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [close, closeAndRestoreFocus, open]);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!open || trigger == null || popup == null) return;

    const triggerBounds = trigger.getBoundingClientRect();
    const lowerBoundaryTop = visibleBoundaryTop(
      document.querySelector<HTMLElement>("[data-popup-bottom-boundary]"),
    );
    setPlacement(
      chooseFloatingMenuPlacement({
        triggerTop: triggerBounds.top,
        triggerBottom: triggerBounds.bottom,
        popupHeight: popup.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        gap: 8,
        ...(lowerBoundaryTop == null ? {} : { lowerBoundaryTop }),
        preferred: preferredPlacement,
      }),
    );
  }, [open, preferredPlacement]);

  return { open, placement, triggerRef, popupRef, closeAndRestoreFocus, toggle };
}
