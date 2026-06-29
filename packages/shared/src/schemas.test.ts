import { describe, expect, it } from "vitest";
import { proxySchema, sourceKindSchema } from "./schemas.js";

describe("schemas", () => {
  it("принимает валидный kind", () => {
    expect(sourceKindSchema.parse("sub")).toBe("sub");
  });
  it("отклоняет неизвестный kind", () => {
    expect(() => sourceKindSchema.parse("nope")).toThrow();
  });
  it("валидирует минимальный proxy", () => {
    const p = proxySchema.parse({
      name: "n1",
      type: "vless",
      server: "ex.com",
      port: 443,
      uuid: "u",
    });
    expect(p.name).toBe("n1");
  });
});
