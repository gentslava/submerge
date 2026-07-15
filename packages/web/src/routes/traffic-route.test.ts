import { describe, expect, it } from "vitest";
import { NAV_ENTRIES, NAV_MOBILE_PRIMARY } from "@/components/nav";
import { router } from "./tree";

describe("Traffic route", () => {
  it("is active in desktop and mobile navigation and registered in the router", () => {
    expect(NAV_ENTRIES).toContainEqual(
      expect.objectContaining({ kind: "link", label: "Трафик", to: "/traffic" }),
    );
    expect(NAV_MOBILE_PRIMARY).toContainEqual(
      expect.objectContaining({ kind: "link", label: "Трафик", to: "/traffic" }),
    );
    expect(router.routesByPath["/traffic"]).toBeDefined();
  });
});
