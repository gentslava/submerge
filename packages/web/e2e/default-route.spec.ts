import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  defaultChannelFixture,
  directChannelFixture,
  expectNoDocumentOverflow,
  type FixtureOverrides,
  installTrpcFixture,
  trpcFixtureByInput,
  trpcFixtureError,
} from "./fixtures";

function fixtures() {
  const channels = [
    directChannelFixture,
    { ...defaultChannelFixture, defaultRoute: "proxy" as const },
  ];
  const overrides: FixtureOverrides = {
    "channels.list": channels,
    "channels.getPool": [],
    "settings.set": { applied: true },
  };
  overrides["channels.setDefaultRoute"] = trpcFixtureByInput((input) => {
    overrides["channels.list"] = [
      ...(overrides["channels.list"] as typeof channels).map((channel) =>
        channel.isDefault
          ? { ...channel, defaultRoute: (input as { route: "proxy" | "direct" }).route }
          : channel,
      ),
    ];
    return { applied: true };
  });
  return overrides;
}

for (const width of [320, 390, 425, 768, 983, 985, 1024, 1440]) {
  test(`Default route selection and persistence fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1024 });
    await page.addInitScript(() => {
      if (!localStorage.getItem("theme")) localStorage.setItem("theme", "dark");
    });
    await installTrpcFixture(page, fixtures());
    await page.goto("/routing");
    await page.getByRole("button", { name: "Развернуть канал «Default»" }).first().click();
    const control = page.getByRole("group", { name: "Маршрут по умолчанию" });
    await expect(control.getByRole("button", { name: "Через VPN", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await control.getByRole("button", { name: "Напрямую", exact: true }).click();
    await expect(control.getByRole("button", { name: "Напрямую", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expectNoDocumentOverflow(page);
    if (width === 1440) {
      const metrics = await control.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        padding: getComputedStyle(element).padding,
        gap: getComputedStyle(element).gap,
        buttons: [...element.querySelectorAll("button")].map((button) => ({
          fontSize: getComputedStyle(button).fontSize,
          padding: getComputedStyle(button).padding,
          color: getComputedStyle(button).color,
          background: getComputedStyle(button).backgroundColor,
        })),
      }));
      expect(metrics).toMatchObject({
        width: 260,
        padding: "3px",
        gap: "3px",
        buttons: [
          { fontSize: "13px", padding: "7px 13px" },
          { fontSize: "13px", padding: "7px 13px" },
        ],
      });
      writeFileSync("/tmp/submerge-default-route-metrics.json", JSON.stringify(metrics, null, 2));
    }
    if (width === 1440 || width === 390)
      await page.screenshot({
        path: `/tmp/submerge-default-route-${width}-dark.png`,
        fullPage: true,
      });
    await page.reload();
    await expect(page.getByText("Всё остальное · напрямую", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Развернуть канал «Default»" }).first().click();
    const direct = control.getByRole("button", { name: "Напрямую", exact: true });
    await expect(direct).toHaveAttribute("aria-current", "true");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Светлая", exact: true }).click();
    await page.goto("/routing");
    await page.getByRole("button", { name: "Развернуть канал «Default»" }).first().click();
    await expectNoDocumentOverflow(page);
    await control.getByRole("button", { name: "Через VPN", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(control.getByRole("button", { name: "Через VPN", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
}

test("pending and failed activation keep the previous route selected and allow retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 1024 });
  const overrides = fixtures();
  overrides["channels.setDefaultRoute"] = trpcFixtureError("Не удалось применить маршрут");
  await installTrpcFixture(page, overrides);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/trpc/**", async (route) => {
    if (route.request().url().includes("channels.setDefaultRoute")) await gate;
    await route.fallback();
  });
  await page.goto("/routing");
  await page.getByRole("button", { name: "Развернуть канал «Default»" }).first().click();
  const control = page.getByRole("group", { name: "Маршрут по умолчанию" });
  const direct = control.getByRole("button", { name: "Напрямую", exact: true });
  await direct.click();
  await expect(direct).toBeDisabled();
  await expectNoDocumentOverflow(page);
  await expect(control.getByRole("button", { name: "Через VPN", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  release();
  await expect(page.getByRole("alert")).toContainText("Не удалось применить маршрут");
  await expect(direct).toBeEnabled();
  await expectNoDocumentOverflow(page);
  await page.screenshot({ path: "/tmp/submerge-default-route-error-390-dark.png" });
  overrides["channels.setDefaultRoute"] = trpcFixtureByInput(() => {
    overrides["channels.list"] = [
      directChannelFixture,
      { ...defaultChannelFixture, defaultRoute: "direct" },
    ];
    return { applied: true };
  });
  await direct.click();
  await expect(direct).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Direct default works with no exit nodes and retains a separate package VPN channel", async ({
  page,
}) => {
  const overrides = fixtures();
  const packages = {
    ...defaultChannelFixture,
    id: "packages",
    name: "Docker и npm",
    isDefault: false,
    priority: 0,
    matcher: { ...defaultChannelFixture.matcher, presets: ["dockerhub", "npm"] },
  };
  overrides["channels.list"] = [packages, directChannelFixture, defaultChannelFixture];
  overrides["nodes.list"] = { now: null, autoNow: null, all: [] };
  await installTrpcFixture(page, overrides);
  await page.goto("/routing");
  await page.getByRole("button", { name: "Развернуть канал «Default»" }).first().click();
  await page
    .getByRole("group", { name: "Маршрут по умолчанию" })
    .getByRole("button", { name: "Напрямую", exact: true })
    .click();
  await expect(page.getByText("Всё остальное · напрямую", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Развернуть канал «Docker и npm»" }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("Всё остальное · напрямую", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Развернуть канал «Docker и npm»" }).first(),
  ).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test("a background refetch during failed activation never confirms the staged route", async ({
  page,
}) => {
  const overrides = fixtures();
  const accepted = [directChannelFixture, defaultChannelFixture];
  let serverChannels = accepted;
  let reads = 0;
  overrides["channels.list"] = trpcFixtureByInput(() => {
    reads++;
    return serverChannels;
  });
  overrides["channels.setDefaultRoute"] = trpcFixtureError("Не удалось применить маршрут");
  await installTrpcFixture(page, overrides);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/trpc/**", async (route) => {
    if (route.request().url().includes("channels.setDefaultRoute")) await gate;
    await route.fallback();
  });
  await page.goto("/routing");
  await page.getByRole("button", { name: "Развернуть канал «Default»" }).first().click();
  const control = page.getByRole("group", { name: "Маршрут по умолчанию" });
  await control.getByRole("button", { name: "Напрямую", exact: true }).click();
  const initialReads = reads;
  serverChannels = [directChannelFixture, { ...defaultChannelFixture, defaultRoute: "direct" }];
  try {
    await page.clock.setFixedTime(new Date(Date.now() + 10_000));
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      window.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => reads).toBeGreaterThan(initialReads);
    await expect(control.getByRole("button", { name: "Через VPN", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
  } finally {
    serverChannels = accepted;
    release();
  }
  await expect(page.getByRole("alert")).toContainText("Не удалось применить маршрут");
  await expect(control.getByRole("button", { name: "Через VPN", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByText("Всё остальное · через VPN", { exact: true })).toBeVisible();
});
