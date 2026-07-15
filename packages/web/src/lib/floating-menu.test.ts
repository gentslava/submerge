import { describe, expect, it } from "vitest";
import { chooseFloatingMenuPlacement, visibleBoundaryTop } from "./floating-menu";

describe("chooseFloatingMenuPlacement", () => {
  it("opens below an upper-edge trigger when the popup fits below", () => {
    expect(
      chooseFloatingMenuPlacement({
        triggerTop: 12,
        triggerBottom: 56,
        popupHeight: 130,
        viewportHeight: 844,
        gap: 8,
      }),
    ).toBe("below");
  });

  it("opens above a lower-edge trigger when the popup fits above", () => {
    expect(
      chooseFloatingMenuPlacement({
        triggerTop: 720,
        triggerBottom: 764,
        popupHeight: 130,
        viewportHeight: 844,
        gap: 8,
        lowerBoundaryTop: 780,
      }),
    ).toBe("above");
  });

  it("chooses the side with more room when neither side fits", () => {
    expect(
      chooseFloatingMenuPlacement({
        triggerTop: 90,
        triggerBottom: 134,
        popupHeight: 180,
        viewportHeight: 260,
        gap: 8,
      }),
    ).toBe("below");
  });
});

describe("visibleBoundaryTop", () => {
  it("ignores a display-none boundary instead of treating its zero rect as visible", () => {
    const boundary = document.createElement("nav");
    boundary.style.display = "none";
    document.body.append(boundary);

    expect(visibleBoundaryTop(boundary)).toBeUndefined();

    boundary.remove();
  });

  it("returns the top edge of a visible boundary", () => {
    const boundary = document.createElement("nav");
    document.body.append(boundary);
    Object.defineProperty(boundary, "getBoundingClientRect", {
      value: () => ({
        top: 760,
        bottom: 844,
        left: 0,
        right: 390,
        width: 390,
        height: 84,
        x: 0,
        y: 760,
        toJSON: () => ({}),
      }),
    });

    expect(visibleBoundaryTop(boundary)).toBe(760);

    boundary.remove();
  });
});
