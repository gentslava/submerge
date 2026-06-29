import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("даёт дефолты при пустом окружении", () => {
    const env = parseEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.DB_PATH).toBe("./data/submerge.db");
    expect(env.ADMIN_PASSWORD).toBeUndefined();
  });
  it("парсит PORT из строки", () => {
    expect(parseEnv({ PORT: "8080" }).PORT).toBe(8080);
  });
  it("падает на невалидном PORT", () => {
    expect(() => parseEnv({ PORT: "abc" })).toThrow();
  });
});
