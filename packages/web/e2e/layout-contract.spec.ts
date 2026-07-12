import { expect, test } from "@playwright/test";
import { expectNoDocumentOverflow, installTrpcFixture } from "./fixtures";

for (const path of ["/", "/connections", "/routing", "/sources", "/settings", "/more"]) {
  test(`page content root measures its own available inline size at ${path}`, async ({ page }) => {
    await installTrpcFixture(page);
    await page.setViewportSize({ width: 1024, height: 844 });
    await page.goto(path);

    const root = page.locator(".responsive-page");
    await expect(root).toHaveCount(1);
    await expect(root).toHaveCSS("container-type", "inline-size");
    expect(await root.evaluate((element) => getComputedStyle(element).containerName)).toContain(
      "app-page",
    );
    await expectNoDocumentOverflow(page);
  });
}
