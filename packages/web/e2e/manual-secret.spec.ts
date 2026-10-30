import { expect, test } from "@playwright/test";
import { expectNoDocumentOverflow, installTrpcFixture, trpcFixtureByInput } from "./fixtures";

for (const width of [390, 1440]) {
  test(`manual three-character secret saves and survives reload at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1024 });
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    const view = {
      hwid: "fixture-hwid",
      mihomoSecret: "previous-key",
      proxyEndpoint: "127.0.0.1:7890",
    };
    await installTrpcFixture(page, {
      "settings.get": view,
      "settings.set": trpcFixtureByInput((input) => {
        expect(input).toEqual({ key: "mihomoSecret", value: "abc" });
        view.mihomoSecret = "abc";
        return { ok: true, applied: true };
      }),
    });
    await page.goto("/settings");
    const secret = page.getByLabel("Секрет mihomo", { exact: true });
    await secret.fill("abc");
    await secret.press("Tab");
    await expect.poll(() => view.mihomoSecret).toBe("abc");
    await page.reload();
    await expect(secret).toHaveValue("abc");
    await expectNoDocumentOverflow(page);
    await page.screenshot({ path: `/tmp/submerge-manual-secret-${width}-dark.png` });
  });
}
