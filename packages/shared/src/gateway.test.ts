import { expect, it } from "vitest";
import { networkSettingsSchema } from "./gateway.js";
import { channelMatcherInputSchema } from "./schemas.js";

it("enables TUN without a home DNS and rejects obsolete engine knobs", () => {
  expect(networkSettingsSchema.parse({ mode: "tun" })).toEqual({ mode: "tun", localResolvers: [] });
  expect(networkSettingsSchema.safeParse({ mode: "tun", ruGeoip: ["RU"] }).success).toBe(false);
  expect(networkSettingsSchema.safeParse({ localResolvers: ["192.168.1.1:"] }).success).toBe(false);
});
it("accepts mounted lists only inside the published directory", () => {
  expect(
    channelMatcherInputSchema.safeParse({
      ruleProviders: [{ url: "file://published/notblocked.txt", behavior: "domain" }],
    }).success,
  ).toBe(true);
  expect(
    channelMatcherInputSchema.safeParse({
      ruleProviders: [{ url: "file://published/../secret.txt", behavior: "domain" }],
    }).success,
  ).toBe(false);
});
