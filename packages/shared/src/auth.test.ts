import { describe, expect, it } from "vitest";
import { loginInput, sessionStatusSchema } from "./schemas.js";

describe("auth schemas", () => {
  it("accepts a non-empty password", () => {
    expect(loginInput.parse({ password: "hunter2" })).toEqual({ password: "hunter2" });
  });
  it("rejects an empty password", () => {
    expect(() => loginInput.parse({ password: "" })).toThrow();
  });
  it("parses session status", () => {
    expect(sessionStatusSchema.parse({ authed: true, required: true })).toEqual({
      authed: true,
      required: true,
    });
  });
});
