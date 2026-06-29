import { describe, expect, it } from "vitest";
import { detectKindHint } from "./detectKind";

describe("detectKindHint", () => {
  it("detects kinds for the type badge", () => {
    expect(detectKindHint("vless://u@h:443")).toBe("vless");
    expect(detectKindHint("happ://crypt5/x")).toBe("happ");
    expect(detectKindHint("https://ex.com/sub")).toBe("sub");
    expect(detectKindHint("clash://install?url=x")).toBe("sub");
    expect(detectKindHint("")).toBe("unknown");
  });

  it("detects vless case-insensitively", () => {
    expect(detectKindHint("VLESS://abc")).toBe("vless");
  });
});
