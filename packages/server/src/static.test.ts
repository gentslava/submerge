import { describe, expect, it } from "vitest";
import { contentTypeFor, safeResolve } from "./static.js";

describe("static helpers", () => {
  it("maps extensions to content types", () => {
    expect(contentTypeFor("/assets/app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/assets/app.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("/x.unknown")).toBe("application/octet-stream");
  });

  it("resolves a url path under the dist dir", () => {
    expect(safeResolve("/dist", "/assets/app.js")).toBe("/dist/assets/app.js");
    expect(safeResolve("/dist", "/")).toBe("/dist/index.html");
  });

  it("blocks path traversal", () => {
    expect(safeResolve("/dist", "/../etc/passwd")).toBeNull();
    expect(safeResolve("/dist", "/..%2f..%2fetc/passwd")).toBeNull();
    expect(safeResolve("/dist", "/assets/../../secret")).toBeNull();
  });
});
