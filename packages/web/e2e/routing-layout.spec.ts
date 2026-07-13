import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { ProxyChannel } from "@submerge/shared";
import {
  defaultChannelFixture,
  directChannelFixture,
  expectNoDocumentOverflow,
  installTrpcFixture,
  trpcFixtureError,
} from "./fixtures";

const advancedChannel: ProxyChannel = {
  id: "advanced",
  name: "Advanced",
  target: "proxy",
  priority: 1,
  enabled: true,
  isDefault: false,
  policy: { kind: "manual", pinnedNode: "NL-1", onFailure: "fallback" },
  matcher: {
    presets: [],
    domains: [],
    keywords: ["ads"],
    ruleProviders: [{ url: "https://rules.example.com/list.yaml", behavior: "classical" }],
    geosite: ["category-ai"],
    geoip: ["US"],
    cidrs: ["10.0.0.0/8"],
  },
  lastReason: null,
  lastReasonAt: null,
};

const populatedChannels = [
  directChannelFixture,
  advancedChannel,
  { ...defaultChannelFixture, priority: 2 },
];

test("routing uses a compact create action on phone and a labelled action in a wide pane", async ({
  page,
}) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/routing");

  const phoneCreate = page.getByRole("button", { name: "Новый канал" });
  await expect(phoneCreate).toBeVisible();
  expect((await phoneCreate.boundingBox())?.width).toBeLessThanOrEqual(44);
  await expectNoDocumentOverflow(page);

  await page.setViewportSize({ width: 1440, height: 1024 });
  const desktopCreate = page.getByRole("button", { name: "Новый канал" });
  await expect(desktopCreate).toBeVisible();
  expect((await desktopCreate.boundingBox())?.width).toBeGreaterThan(100);
});

test("routing switches create actions exactly at the 42rem page boundary", async ({ page }) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 983, height: 844 });
  await page.goto("/routing");
  expect(
    (await page.getByRole("button", { name: "Новый канал" }).boundingBox())?.width,
  ).toBeLessThanOrEqual(44);
  await expectNoDocumentOverflow(page);

  await page.setViewportSize({ width: 984, height: 844 });
  expect(
    (await page.getByRole("button", { name: "Новый канал" }).boundingBox())?.width,
  ).toBeGreaterThan(100);
  await expectNoDocumentOverflow(page);
});

test("routing summarizes advanced matcher rules without inventing pool state", async ({ page }) => {
  await installTrpcFixture(page, { "channels.list": populatedChannels });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/routing");

  const summary = page.locator(".matcher-summary").filter({ hasText: "ключ:ads" });
  await expect(summary).toContainText("ключ:ads");
  await expect(summary).not.toContainText("Все узлы");
  await expect(summary.getByText("+4", { exact: true }).first()).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test("Direct exposes its built-in and custom matchers without proxy-only controls", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installTrpcFixture(page, { "channels.list": populatedChannels });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/routing");

  await expect(page.getByText("Локальная сеть", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Локальные домены", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("+7", { exact: true }).first()).toBeVisible();
  const header = page.locator(".direct-channel-header");
  const compactEvidence = await header.evaluate((element) => {
    const identity = element.querySelector<HTMLElement>(".direct-channel-identity-controls");
    const summary = element.querySelector<HTMLElement>(".matcher-summary");
    const firstChip = summary?.firstElementChild as HTMLElement | null;
    const headerStyle = getComputedStyle(element);
    const chipStyle = firstChip == null ? null : getComputedStyle(firstChip);
    const identityRect = identity?.getBoundingClientRect();
    const summaryRect = summary?.getBoundingClientRect();
    return {
      flexDirection: headerStyle.flexDirection,
      gap: headerStyle.rowGap,
      padding: [
        headerStyle.paddingTop,
        headerStyle.paddingRight,
        headerStyle.paddingBottom,
        headerStyle.paddingLeft,
      ],
      summaryBelowIdentity:
        identityRect != null && summaryRect != null && summaryRect.top >= identityRect.bottom,
      summaryContained:
        summary != null &&
        Array.from(summary.children).every((child) => {
          const childRect = child.getBoundingClientRect();
          const parentRect = summary.getBoundingClientRect();
          return childRect.left >= parentRect.left && childRect.right <= parentRect.right + 1;
        }),
      firstChip: chipStyle && {
        fontSize: chipStyle.fontSize,
        paddingLeft: chipStyle.paddingLeft,
        paddingTop: chipStyle.paddingTop,
      },
    };
  });
  expect(compactEvidence).toEqual({
    flexDirection: "column",
    gap: "10px",
    padding: ["12px", "14px", "12px", "14px"],
    summaryBelowIdentity: true,
    summaryContained: true,
    firstChip: { fontSize: "10px", paddingLeft: "7px", paddingTop: "3px" },
  });
  await writeFile(
    "/tmp/submerge-direct-compact-390.json",
    JSON.stringify(compactEvidence, null, 2),
  );
  await page.screenshot({ path: "/tmp/submerge-direct-compact-dark-390.png", fullPage: true });

  await page.getByRole("button", { name: "Развернуть канал «Direct»" }).first().click();
  await expect(page.getByText("Системные исключения", { exact: true })).toBeVisible();
  await expect(page.getByText("CIDR", { exact: true })).toBeVisible();
  await expect(page.getByText("Пул", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Политика", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Удалить канал" })).toHaveCount(0);
  const editorEvidence = await page.locator(".direct-editor-system").evaluate((system) => {
    const caption = system.querySelector<HTMLElement>(".direct-section-caption");
    const preset = system.querySelector<HTMLElement>(".direct-preset-card");
    const systemStyle = getComputedStyle(system);
    const captionStyle = caption == null ? null : getComputedStyle(caption);
    const presetStyle = preset == null ? null : getComputedStyle(preset);
    return {
      systemPadding: [systemStyle.paddingTop, systemStyle.paddingLeft],
      captionFontSize: captionStyle?.fontSize,
      presetPadding: presetStyle && [presetStyle.paddingTop, presetStyle.paddingLeft],
    };
  });
  expect(editorEvidence).toEqual({
    systemPadding: ["14px", "14px"],
    captionFontSize: "11px",
    presetPadding: ["10px", "12px"],
  });
  await writeFile("/tmp/submerge-direct-editor-390.json", JSON.stringify(editorEvidence, null, 2));
  await page.screenshot({ path: "/tmp/submerge-direct-expanded-dark-390.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

test("Direct expanded desktop head uses the approved elevated treatment", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installTrpcFixture(page, { "channels.list": populatedChannels });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/routing");

  await page.getByRole("button", { name: "Развернуть канал «Direct»" }).first().click();
  const header = page.locator(".direct-channel-header");
  await expect(header).toHaveCSS("background-color", "rgb(22, 25, 34)");
  await expect(page.getByText("Пользовательские правила", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/submerge-direct-expanded-dark-1440.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

test("Direct collapsed light state retains its surface hierarchy", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/routing");

  const header = page.locator(".direct-channel-header");
  await expect(header.locator("..")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.screenshot({ path: "/tmp/submerge-direct-collapsed-light-1440.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

test("disabled Direct desktop state stays visible and clearly inert", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installTrpcFixture(page, {
    "channels.list": [{ ...directChannelFixture, enabled: false }, defaultChannelFixture],
  });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/routing");

  const header = page.locator(".direct-channel-header");
  await expect(header.locator("..")).toHaveCSS("opacity", "0.5");
  await expect(page.getByRole("switch", { name: "Включить канал «Direct»" })).not.toBeChecked();
  await page.screenshot({ path: "/tmp/submerge-direct-disabled-dark-1440.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

test("Direct can be disabled in light theme while its configured rules remain visible", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await installTrpcFixture(page, {
    "channels.list": [{ ...directChannelFixture, enabled: false }, defaultChannelFixture],
  });
  await page.setViewportSize({ width: 425, height: 844 });
  await page.goto("/routing");

  const directSwitch = page.getByRole("switch", { name: "Включить канал «Direct»" });
  await expect(directSwitch).not.toBeChecked();
  await expect(page.getByText("Локальная сеть", { exact: true }).first()).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test("routing explains the permanent Direct and Default channels when no proxy channel exists", async ({
  page,
}) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/routing");

  await expect(page.getByText(/Direct направляет настроенные исключения напрямую/)).toBeVisible();
  await expect(page.getByText(/Default — весь остальной трафик/)).toBeVisible();
});

test("routing renders its channel-list error state", async ({ page }) => {
  await installTrpcFixture(page, {
    "channels.list": trpcFixtureError("fixture failure"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/routing");

  await expect(page.getByText("Не удалось загрузить каналы.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить" })).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test("mobile reorder sends Direct and proxy ids in their new order without Default", async ({
  page,
}) => {
  await installTrpcFixture(page, { "channels.list": populatedChannels });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/routing");

  const requestPromise = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/trpc/channels.reorder",
  );
  await page.getByRole("button", { name: "Опустить канал «Direct» ниже" }).click();
  const request = await requestPromise;
  const payload = request.postDataJSON() as {
    json?: { ids?: string[] };
    0?: { ids?: string[]; json?: { ids?: string[] } };
  };
  const ids = payload.json?.ids ?? payload[0]?.json?.ids ?? payload[0]?.ids;
  expect(ids).toEqual(["advanced", "direct"]);
  expect(ids).not.toContain("default");
});

for (const width of [320, 390, 425, 768, 983, 984, 1024, 1440]) {
  test(`Direct card remains complete and overflow-free at ${width}px`, async ({ page }) => {
    await installTrpcFixture(page, { "channels.list": populatedChannels });
    await page.setViewportSize({ width, height: width === 1440 ? 1024 : 844 });
    await page.goto("/routing");

    await expect(page.getByText("Direct", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("switch", { name: "Включить канал «Direct»" })).toBeVisible();
    await expectNoDocumentOverflow(page);
  });
}
