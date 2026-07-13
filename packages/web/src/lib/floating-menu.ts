export type FloatingMenuPlacement = "above" | "below";

interface FloatingMenuGeometry {
  triggerTop: number;
  triggerBottom: number;
  popupHeight: number;
  viewportHeight: number;
  gap: number;
  lowerBoundaryTop?: number;
  preferred?: FloatingMenuPlacement;
}

export function chooseFloatingMenuPlacement({
  triggerTop,
  triggerBottom,
  popupHeight,
  viewportHeight,
  gap,
  lowerBoundaryTop = viewportHeight,
  preferred = "above",
}: FloatingMenuGeometry): FloatingMenuPlacement {
  const availableAbove = triggerTop;
  const availableBelow = Math.max(0, lowerBoundaryTop - triggerBottom);
  const requiredSpace = popupHeight + gap;
  const fitsAbove = availableAbove >= requiredSpace;
  const fitsBelow = availableBelow >= requiredSpace;

  if (preferred === "above" && fitsAbove) return "above";
  if (preferred === "below" && fitsBelow) return "below";
  if (fitsAbove) return "above";
  if (fitsBelow) return "below";
  return availableAbove >= availableBelow ? "above" : "below";
}

export function visibleBoundaryTop(boundary: HTMLElement | null): number | undefined {
  if (boundary == null) return undefined;
  const style = getComputedStyle(boundary);
  if (style.display === "none" || style.visibility === "hidden") return undefined;

  const bounds = boundary.getBoundingClientRect();
  if (bounds.height <= 0 || bounds.bottom <= 0 || bounds.top >= window.innerHeight)
    return undefined;
  return bounds.top;
}
