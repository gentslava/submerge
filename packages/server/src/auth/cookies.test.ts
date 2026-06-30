import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  parseCookies,
  SESSION_COOKIE,
  serializeSessionCookie,
} from "./cookies.js";

describe("cookies", () => {
  it("parses a cookie header", () => {
    expect(parseCookies("sid=abc; theme=dark")).toEqual({ sid: "abc", theme: "dark" });
    expect(parseCookies(undefined)).toEqual({});
  });
  it("keeps a malformed %-encoded value raw instead of throwing", () => {
    expect(parseCookies("sid=%")).toEqual({ sid: "%" });
  });
  it("serializes a session cookie (httpOnly, lax, path)", () => {
    const c = serializeSessionCookie("abc", 3600, false);
    expect(c).toContain(`${SESSION_COOKIE}=abc`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=3600");
    expect(c).not.toContain("Secure");
  });
  it("adds Secure when requested", () => {
    expect(serializeSessionCookie("abc", 3600, true)).toContain("Secure");
  });
  it("clears the cookie with Max-Age=0", () => {
    expect(clearSessionCookie(false)).toContain(`${SESSION_COOKIE}=;`);
    expect(clearSessionCookie(false)).toContain("Max-Age=0");
  });
});
