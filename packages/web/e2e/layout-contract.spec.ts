import { expect, test } from "@playwright/test";
import { expectNoDocumentOverflow, installTrpcFixture } from "./fixtures";

const paths = [
  "/",
  "/traffic",
  "/connections",
  "/routing",
  "/logs",
  "/diagnostics",
  "/sources",
  "/settings",
  "/more",
];

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

for (const width of [390, 1440]) {
  test(`skip link moves keyboard focus past navigation at ${width}px`, async ({ page }) => {
    await installTrpcFixture(page);
    await page.setViewportSize({ width, height: width === 1440 ? 1024 : 844 });
    await page.goto("/");

    const skipLink = page.getByRole("link", { name: "Перейти к содержимому" });
    const main = page.getByRole("main");
    await expect(skipLink).not.toBeInViewport();

    await page.keyboard.press("Tab");
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeInViewport();
    if (width === 1440) {
      await page.screenshot({ path: "/tmp/submerge-skip-link-1440.png", fullPage: true });
    }

    if (width === 1440) {
      const brand = page.getByRole("link", { name: "submerge — на главную" });
      const skipBox = await skipLink.boundingBox();
      const brandBox = await brand.boundingBox();
      if (!skipBox || !brandBox) throw new Error("Skip-link geometry is unavailable");
      expect(skipBox.x).toBeLessThan(brandBox.x + brandBox.width);
      expect(skipBox.y).toBeLessThan(brandBox.y + brandBox.height);
    }

    await page.keyboard.press("Enter");
    await expect(main).toBeFocused();
    await expect(skipLink).not.toBeInViewport();
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
