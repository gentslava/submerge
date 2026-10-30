import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { NetworkSettings } from "@submerge/shared";
import {
  expectNoDocumentOverflow,
  type FixtureOverrides,
  installTrpcFixture,
  trpcFixtureByInput,
  trpcFixtureError,
} from "./fixtures";

function fixtures(): FixtureOverrides {
  const overrides: FixtureOverrides = {
    "gateway.configuration": { mode: "proxy", localResolvers: [] },
    "settings.set": { applied: true },
  };
  overrides["gateway.set"] = trpcFixtureByInput((input) => {
    overrides["gateway.configuration"] = input;
    return { applied: true };
  });
  return overrides;
}

for (const width of [320, 390, 425, 768, 983, 985, 1024, 1440]) {
  test(`connection mode and DNS fit ${width}px in both themes`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1024 });
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await installTrpcFixture(page, fixtures());
    await page.goto("/settings");
    const mode = page.getByRole("region", { name: "Режим подключения", exact: true });
    await expect(mode.getByRole("button", { name: "Прокси" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(mode.getByRole("button", { name: "Проверить" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "DNS домашней сети" })).toBeVisible();
    await mode.getByRole("button", { name: "TUN", exact: true }).click();
    await expect(mode.getByRole("button", { name: "TUN", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expectNoDocumentOverflow(page);
    if (width === 1440) {
      const metrics = await mode.evaluate((section) => {
        const control = section.querySelector<HTMLElement>(".segmented-control");
        const label = section.querySelector<HTMLElement>("h2");
        return {
          width: control?.getBoundingClientRect().width,
          font: label && getComputedStyle(label).fontSize,
          buttons: [...section.querySelectorAll(".segmented-control button")].map(
            (button) => getComputedStyle(button).fontSize,
          ),
        };
      });
      expect(metrics).toMatchObject({ width: 260, font: "15px", buttons: ["13px", "13px"] });
      writeFileSync("/tmp/submerge-network-ui-metrics.json", JSON.stringify(metrics));
    }
    if (width === 1440 || width === 390)
      await page.screenshot({ path: `/tmp/submerge-network-${width}-dark.png` });
    await page.getByRole("button", { name: "Светлая", exact: true }).click();
    await expectNoDocumentOverflow(page);
    if (width === 390) await page.screenshot({ path: "/tmp/submerge-network-390-light.png" });
    expect(errors).toEqual([]);
  });
}

test("immediate mode switch shows progress, retains previous mode on failure and retries by selecting TUN", async ({
  page,
}) => {
  const overrides = fixtures();
  let attempts = 0;
  overrides["gateway.set"] = trpcFixtureByInput((input) => {
    if (++attempts === 1)
      return trpcFixtureError("Не удалось включить TUN. Проверьте работу сервера.");
    overrides["gateway.configuration"] = input;
    return { applied: true };
  });
  await installTrpcFixture(page, overrides);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/trpc/**", async (route) => {
    if (route.request().method() === "POST" && route.request().url().includes("gateway.set"))
      await gate;
    await route.fallback();
  });
  await page.goto("/settings");
  const mode = page.getByRole("region", { name: "Режим подключения", exact: true });
  const tun = mode.getByRole("button", { name: "TUN", exact: true });
  await tun.click();
  await expect(mode.getByRole("status")).toHaveText("Включаем TUN…");
  await expect(tun).toBeDisabled();
  await expect(mode.getByRole("button", { name: "Прокси" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  release();
  await expect(mode.getByRole("alert")).toContainText("Не удалось включить TUN");
  await tun.focus();
  await page.keyboard.press("Enter");
  await expect(tun).toHaveAttribute("aria-current", "true");
  await expect(mode.getByRole("alert")).toHaveCount(0);
});

test("optional DNS saves on blur, rejects malformed values and can be cleared", async ({
  page,
}) => {
  const overrides = fixtures();
  const submitted: NetworkSettings[] = [];
  overrides["gateway.set"] = trpcFixtureByInput((input) => {
    submitted.push(input as NetworkSettings);
    overrides["gateway.configuration"] = input;
    return { applied: true };
  });
  await installTrpcFixture(page, overrides);
  await page.goto("/settings");
  const dns = page.getByRole("textbox", { name: "DNS домашней сети" });
  await dns.fill("wrong");
  await dns.blur();
  await expect(
    page.getByRole("region", { name: "DNS", exact: true }).getByRole("alert"),
  ).toContainText("IP-адрес");
  expect(submitted).toEqual([]);
  await dns.fill("192.168.1.1");
  await dns.press("Enter");
  await expect(dns).toHaveValue("192.168.1.1");
  await expect.poll(() => submitted.length).toBe(1);
  await dns.fill("");
  await dns.blur();
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted[1]).toEqual({ mode: "proxy", localResolvers: [] });
});

test("load failure is visible and retryable", async ({ page }) => {
  const overrides = fixtures();
  overrides["gateway.configuration"] = trpcFixtureError("offline");
  await installTrpcFixture(page, overrides);
  await page.goto("/settings");
  const mode = page.getByRole("region", { name: "Режим подключения", exact: true });
  await expect(mode.getByRole("alert")).toContainText("Не удалось загрузить");
  overrides["gateway.configuration"] = { mode: "proxy", localResolvers: [] };
  await mode.getByRole("button", { name: "Повторить" }).click();
  await expect(mode.getByRole("button", { name: "Прокси" })).toBeVisible();
});

test("published files are edited in Routing Direct and Default, with RU matchers visible only there", async ({
  page,
}) => {
  const { directChannelFixture, defaultChannelFixture } = await import("./fixtures");
  const channels = [
    {
      ...directChannelFixture,
      matcher: {
        ...directChannelFixture.matcher,
        domains: ["ru", "su", "xn--p1ai"],
        geosite: ["category-ru"],
        geoip: ["RU"],
        ruleProviders: [],
      },
    },
    defaultChannelFixture,
  ];
  const overrides: FixtureOverrides = {
    "channels.list": channels,
    "channels.getPool": [],
    "channels.publishedLists": [
      "notblocked.txt",
      "custom.txt",
      "a-very-long-published-file-name-for-responsive-container-verification.txt",
    ],
  };
  const submitted: unknown[] = [];
  overrides["channels.updateDirect"] = trpcFixtureByInput((input) => {
    submitted.push(input);
    return { applied: true };
  });
  overrides["channels.update"] = trpcFixtureByInput((input) => {
    submitted.push(input);
    return { applied: true };
  });
  await installTrpcFixture(page, overrides);
  await page.goto("/routing");
  await page.getByRole("button", { name: "Развернуть канал «Direct»" }).first().click();
  await expect(page.getByText("category-ru", { exact: true })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Добавить опубликованный список" })
    .selectOption("notblocked.txt");
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({
    matcher: {
      geoip: ["RU"],
      ruleProviders: [{ url: "file://published/notblocked.txt", behavior: "domain" }],
    },
  });
  await page.getByRole("button", { name: "Развернуть канал «Default»" }).first().click();
  await expect(page.getByText("Всегда через VPN", { exact: true })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Добавить опубликованный список" })
    .last()
    .selectOption("custom.txt");
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted[1]).toMatchObject({
    id: "default",
    matcher: { ruleProviders: [{ url: "file://published/custom.txt", behavior: "domain" }] },
  });
  await page
    .getByRole("combobox", { name: "Добавить опубликованный список" })
    .last()
    .selectOption("a-very-long-published-file-name-for-responsive-container-verification.txt");
  await expect.poll(() => submitted.length).toBe(3);
  for (const width of [320, 390, 425, 768, 983, 985, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1024 });
    await expectNoDocumentOverflow(page);
    if (width === 1440 || width === 390)
      await page.screenshot({ path: `/tmp/submerge-network-routing-${width}.png` });
  }
});
