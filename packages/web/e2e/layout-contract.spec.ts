import { expect, test } from "@playwright/test";
import { expectNoDocumentOverflow, installTrpcFixture } from "./fixtures";

const paths = ["/", "/traffic", "/connections", "/routing", "/sources", "/settings", "/more"];

for (const width of [320, 390, 425, 768, 1024, 1440]) {
  test(`all page roots fit their application scroll container at ${width}px`, async ({ page }) => {
    await installTrpcFixture(page);
    await page.setViewportSize({ width, height: width === 1440 ? 1024 : 844 });

    for (const path of paths) {
      await page.goto(path);
      const root = page.locator(".responsive-page");
      await expect(root).toHaveCount(1);
      await expect(root).toHaveCSS("container-type", "inline-size");
      expect(await root.evaluate((element) => getComputedStyle(element).containerName)).toContain(
        "app-page",
      );
      await expectNoDocumentOverflow(page);
    }
  });
}

test("overflow contract catches an overflowing app-main even when the document still fits", async ({
  page,
}) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 1024, height: 844 });
  await page.goto("/");
  await page.locator(".app-main").evaluate((main) => {
    const overflow = document.createElement("div");
    overflow.style.width = `${main.clientWidth + 200}px`;
    overflow.style.height = "1px";
    main.append(overflow);
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);

  await expect(expectNoDocumentOverflow(page)).rejects.toThrow();
});
