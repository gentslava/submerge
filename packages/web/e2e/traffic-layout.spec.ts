import { expect, type Page, test } from "@playwright/test";
import type { LiveEvent, NodeView } from "@submerge/shared";
import {
  expectNoDocumentOverflow,
  type FixtureOverrides,
  installTrpcFixture,
  trpcFixtureError,
} from "./fixtures";

const activeNode = "Амстердам — основной маршрут";
const nodeHistory = Array.from({ length: 40 }, (_, index) => 34 + ((index * 13) % 58));
const nodeHistoryTimestamps = Array.from({ length: 40 }, (_, index) =>
  new Date(Date.UTC(2026, 6, 15, 0, index * 5)).toISOString(),
);
const nodeView: NodeView = {
  now: "AUTO",
  autoNow: activeNode,
  all: [
    {
      name: activeNode,
      type: "vless",
      delay: 42,
      network: "tcp",
      security: "reality",
      history: nodeHistory,
      historyTimestamps: nodeHistoryTimestamps,
    },
  ],
};

const connections = {
  connections: Array.from({ length: 12 }, (_, index) => ({
    id: `connection-${index + 1}`,
    source: "Safari",
    host: `service-${index + 1}.example.test`,
    destIp: `203.0.113.${index + 1}`,
    port: "443",
    network: "tcp" as const,
    node: activeNode,
    up: 1_024 * index,
    down: 2_048 * index,
    start: "2026-07-15T00:00:00.000Z",
  })),
};

function populatedEvents(): LiveEvent[] {
  const sample = {
    type: "traffic" as const,
    up: 1.31 * 1024 * 1024,
    down: 9.4 * 1024 * 1024,
  };
  return [
    { type: "health", mihomo: true },
    { type: "nodeUpdate", view: nodeView },
    { type: "totals", up: 10_000, down: 20_000 },
    sample,
    sample,
    sample,
    { type: "totals", up: 10_000 + 16 * 1024 * 1024, down: 20_000 + 26 * 1024 * 1024 },
  ];
}

async function openTraffic(
  page: Page,
  options: {
    events?: readonly LiveEvent[];
    end?: "return" | "disconnect";
    overrides?: FixtureOverrides;
    colorScheme?: "dark" | "light";
  } = {},
): Promise<void> {
  await page.emulateMedia({ colorScheme: options.colorScheme ?? "dark" });
  await installTrpcFixture(
    page,
    { "connections.list": connections, ...options.overrides },
    {
      subscriptions: {
        "live.stream": {
          events: options.events ?? populatedEvents(),
          ...(options.end ? { end: options.end } : {}),
        },
      },
    },
  );
  await page.goto("/traffic");
  await expect(page.getByRole("heading", { name: "Трафик" })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

function visibleChildren(page: Page, selector: string) {
  return page
    .locator(selector)
    .evaluate(
      (element) =>
        Array.from(element.children).filter((child) => getComputedStyle(child).display !== "none")
          .length,
    );
}

test("populated dark desktop matches the Traffic data layout and reset contract", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.addInitScript(() => {
    const animationFrames: string[] = [];
    (
      window as typeof window & {
        __trafficChartAnimations: string[];
      }
    ).__trafficChartAnimations = animationFrames;
    const originalAnimate = Element.prototype.animate;
    Element.prototype.animate = function animate(keyframes, options) {
      if (this.closest(".traffic-throughput-plot, .traffic-latency-plot")) {
        animationFrames.push(JSON.stringify(keyframes));
      }
      return originalAnimate.call(this, keyframes, options);
    };
  });
  await openTraffic(page);

  expect(
    await page
      .locator(".traffic-metrics")
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
  ).toBe(4);
  await expect(page.locator(".traffic-metric-icon").first()).toBeVisible();
  await expect(page.locator(".traffic-chart-variant--wide .traffic-latency-plot")).toBeVisible();
  await expect(page.locator(".traffic-chart-variant--wide .traffic-throughput-plot")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "12 соединений — открыть экран Соединения" }),
  ).toBeVisible();
  await expect(page.getByTitle("9.4 МБ/с", { exact: true })).toBeVisible();
  const animationFrames = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __trafficChartAnimations: string[];
        }
      ).__trafficChartAnimations,
  );
  expect(animationFrames.some((frames) => frames.includes("scaleY(0)"))).toBe(true);
  await expect(page.getByText(/40 замеров за/)).toHaveClass(/sr-only/);
  await expect(page.getByText(/1 замер за 3 с/)).toHaveClass(/sr-only/);

  const throughputSample = page
    .locator('.traffic-chart-variant--wide [data-testid="traffic-throughput-sample"]')
    .last();
  await throughputSample.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("↓ 9.4 МБ/с");
  await expect(tooltip).toContainText("↑ 1.3 МБ/с");
  await expect(tooltip).toContainText("пик");
  await throughputSample.click();
  await expect(tooltip).toContainText("закреплено");
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await page.screenshot({ path: "/tmp/traffic-dark-1440.png", fullPage: true });

  await page.getByRole("button", { name: "Сбросить" }).click();
  await expect(page.getByText("Сессия сброшена")).toBeVisible();
  await expect(page.getByTitle("9.4 МБ/с", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "12 соединений — открыть экран Соединения" }),
  ).toBeVisible();
  await expect(page.getByTitle("0 Б")).toBeVisible();
  await expect(page.getByText("Нет данных о задержке", { exact: true })).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test("light desktop uses the approved light latency history palette", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openTraffic(page, { colorScheme: "light" });

  await expect(page.locator("html")).not.toHaveClass(/dark/);
  const latencyBars = page.locator(".traffic-chart-variant--wide .traffic-latency-plot > *");
  await expect(latencyBars.first().locator("span")).toHaveCSS(
    "background-color",
    "rgb(216, 218, 243)",
  );
  await expect(latencyBars.last().locator("span")).toHaveCSS(
    "background-color",
    "rgb(99, 102, 241)",
  );
  await page.screenshot({ path: "/tmp/traffic-light-1440.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

test("mobile keeps a 2x2 metric grid, compact reset, and reachable final chart", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTraffic(page);
  await expect(page.getByTitle("9.4 МБ/с", { exact: true })).toBeVisible();

  expect(
    await page
      .locator(".traffic-metrics")
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
  ).toBe(2);
  await expect(page.locator(".traffic-reset-label")).toBeHidden();
  await expect(page.getByRole("button", { name: "Сбросить" })).toHaveCSS("width", "44px");
  await expect(page.locator(".traffic-metric-icon").first()).toBeHidden();
  await expect(page.locator(".traffic-metric-compact-icon").first()).toBeVisible();
  expect(await visibleChildren(page, ".traffic-chart-variant--compact .traffic-latency-plot")).toBe(
    24,
  );
  expect(
    await visibleChildren(page, ".traffic-chart-variant--compact .traffic-throughput-plot"),
  ).toBe(20);

  await expect(page.locator(".traffic-header")).toBeVisible();
  await expect(page.locator(".traffic-metric").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Задержка основного канала" })).toBeVisible();
  const throughputBox = await page
    .getByRole("region", { name: "Пропускная способность" })
    .boundingBox();
  expect(throughputBox).not.toBeNull();

  await page
    .locator('.traffic-chart-variant--compact [data-testid="traffic-throughput-sample"]')
    .last()
    .hover();
  const tooltipBox = await page.getByRole("tooltip").boundingBox();
  expect(tooltipBox?.x ?? -Infinity).toBeGreaterThanOrEqual(throughputBox?.x ?? Infinity);
  expect((tooltipBox?.x ?? Infinity) + (tooltipBox?.width ?? 0)).toBeLessThanOrEqual(
    (throughputBox?.x ?? -Infinity) + (throughputBox?.width ?? 0),
  );
  await page.mouse.move(0, 0);

  const lastChart = page.getByRole("region", { name: "Пропускная способность" });
  await lastChart.scrollIntoViewIfNeeded();
  const chartBox = await lastChart.boundingBox();
  const navBox = await page.locator("nav.fixed").boundingBox();
  expect((chartBox?.y ?? Infinity) + (chartBox?.height ?? 0)).toBeLessThanOrEqual(
    navBox?.y ?? -Infinity,
  );
  await page.screenshot({ path: "/tmp/traffic-mobile-390.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

test("Traffic state fixtures stay explicit and partial failures stay partial", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });

  await openTraffic(page, {
    overrides: { "connections.list": { connections: [] } },
    events: [
      { type: "health", mihomo: true },
      { type: "nodeUpdate", view: nodeView },
    ],
  });
  await expect(page.getByText("Подключаем live-метрики")).toBeVisible();

  await openTraffic(page, {
    overrides: { "connections.list": { connections: [] } },
    events: [
      { type: "health", mihomo: true },
      { type: "nodeUpdate", view: nodeView },
      { type: "traffic", up: 0, down: 0 },
    ],
  });
  await expect(page.getByText("Прокси подключён, трафика нет")).toBeVisible();
  await expect(page.getByText("Трафик появится после первого запроса")).toBeVisible();
  await expect(page.getByTitle("0 Б/с")).toHaveCount(2);

  await openTraffic(page, {
    events: [
      { type: "nodeUpdate", view: nodeView },
      { type: "traffic", up: 1.31 * 1024 * 1024, down: 9.4 * 1024 * 1024 },
      { type: "health", mihomo: false },
    ],
  });
  await expect(page.getByText("Переподключаемся к mihomo")).toBeVisible();
  await expect(page.getByText("Нет новых данных · повторяем автоматически")).toBeVisible();
  await expect(page.getByTitle("9.4 МБ/с", { exact: true })).toBeVisible();

  const emptyView: NodeView = { now: "AUTO", autoNow: null, all: [] };
  await openTraffic(page, {
    overrides: { "nodes.list": emptyView, "connections.list": { connections: [] } },
    events: [
      { type: "health", mihomo: true },
      { type: "nodeUpdate", view: emptyView },
    ],
  });
  await expect(page.getByText("Добавьте первый источник")).toBeVisible();
  await expect(page.getByRole("link", { name: "Перейти к источникам" })).toBeVisible();

  await openTraffic(page, {
    overrides: { "connections.list": trpcFixtureError("mihomo unavailable") },
  });
  await expect(page.getByText("Соединения недоступны")).toBeVisible();
  await expect(page.getByTitle("9.4 МБ/с", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Соединения недоступны — открыть экран Соединения" }),
  ).toBeVisible();
});

test("a disconnected stream retains its last values and becomes stale", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openTraffic(page, {
    end: "disconnect",
    events: [
      { type: "health", mihomo: true },
      { type: "nodeUpdate", view: nodeView },
      { type: "traffic", up: 1.31 * 1024 * 1024, down: 9.4 * 1024 * 1024 },
    ],
  });

  await expect(page.getByTitle("9.4 МБ/с", { exact: true })).toBeVisible();
  await expect(page.getByText("Переподключаемся к mihomo")).toBeVisible({ timeout: 7_000 });
  await expect(page.getByTitle("9.4 МБ/с", { exact: true })).toBeVisible();
});

test("Traffic has no overflow at the supported viewport widths", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openTraffic(page);

  for (const width of [320, 390, 425, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1024 : 844 });
    await expectNoDocumentOverflow(page);
  }
});

test("Traffic switches layouts on app-page boundaries rather than viewport guesses", async ({
  page,
}) => {
  const cases = [
    { viewport: 320, inline: false, data: false },
    { viewport: 480, inline: false, data: false },
    { viewport: 640, inline: false, data: false },
    { viewport: 983, inline: false, data: false },
    { viewport: 984, inline: true, data: false },
    { viewport: 1079, inline: true, data: false },
    { viewport: 1080, inline: true, data: true },
  ];

  await page.setViewportSize({ width: cases[0].viewport, height: 844 });
  await openTraffic(page);

  for (const item of cases) {
    await page.setViewportSize({ width: item.viewport, height: 844 });
    const resetLabel = page.locator(".traffic-reset-label");
    if (item.inline) {
      await expect(resetLabel).toBeVisible();
    } else {
      await expect(resetLabel).toBeHidden();
    }
    await expect(page.locator(".traffic-metric-icon").first()).toHaveCSS(
      "display",
      item.inline ? "flex" : "none",
    );
    expect(
      await page
        .locator(".traffic-metrics")
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
    ).toBe(item.data ? 4 : 2);
    const activeChart = item.inline
      ? ".traffic-chart-variant--wide .traffic-latency-plot"
      : ".traffic-chart-variant--compact .traffic-latency-plot";
    const inactiveChart = item.inline
      ? ".traffic-chart-variant--compact .traffic-latency-plot"
      : ".traffic-chart-variant--wide .traffic-latency-plot";
    await expect(page.locator(activeChart)).toBeVisible();
    await expect(page.locator(inactiveChart)).toBeHidden();
    await expectNoDocumentOverflow(page);
  }
});
