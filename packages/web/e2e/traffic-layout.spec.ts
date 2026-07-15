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
  const samples: LiveEvent[] = Array.from({ length: 59 }, (_, index) => ({
    type: "traffic" as const,
    up: 180_000 + ((index * 81_000) % 1_050_000),
    down: 620_000 + ((index * 290_000) % 8_000_000),
  }));
  return [
    { type: "health", mihomo: true },
    { type: "nodeUpdate", view: nodeView },
    { type: "totals", up: 10_000, down: 20_000 },
    ...samples,
    { type: "traffic", up: 1.31 * 1024 * 1024, down: 9.4 * 1024 * 1024 },
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
  await openTraffic(page);

  expect(
    await page
      .locator(".traffic-metrics")
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
  ).toBe(4);
  await expect(page.locator(".traffic-metric-icon").first()).toBeVisible();
  await expect(page.locator(".traffic-chart-variant--wide .traffic-latency-plot")).toHaveCSS(
    "height",
    "150px",
  );
  await expect(page.locator(".traffic-chart-variant--wide .traffic-throughput-plot")).toHaveCSS(
    "height",
    "150px",
  );
  const headerBox = await page.locator(".traffic-header").boundingBox();
  const metricBox = await page.locator(".traffic-metric").first().boundingBox();
  const latencyBox = await page
    .getByRole("region", { name: "Задержка основного канала" })
    .boundingBox();
  const throughputBox = await page
    .getByRole("region", { name: "Пропускная способность" })
    .boundingBox();
  expect(headerBox?.height).toBeCloseTo(50, 0);
  expect(metricBox?.height).toBeCloseTo(89, 0);
  expect(latencyBox?.height).toBeCloseTo(251, 0);
  expect(throughputBox?.height).toBeCloseTo(224, 0);
  expect(metricBox?.y).toBeCloseTo(98, 0);
  expect(latencyBox?.y).toBeCloseTo(209, 0);
  expect(throughputBox?.y).toBeCloseTo(482, 0);
  await expect(
    page.getByRole("link", { name: "12 соединений — открыть экран Соединения" }),
  ).toBeVisible();
  await expect(page.getByText(/40 замеров за/)).toHaveClass(/sr-only/);
  await expect(page.getByText(/60 замеров за/)).toHaveClass(/sr-only/);
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
  const latencyBars = page.locator(".traffic-chart-variant--wide .traffic-latency-plot > span");
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
  ).toBe(18);

  const headerBox = await page.locator(".traffic-header").boundingBox();
  const metricBox = await page.locator(".traffic-metric").first().boundingBox();
  const latencyBox = await page
    .getByRole("region", { name: "Задержка основного канала" })
    .boundingBox();
  const throughputBox = await page
    .getByRole("region", { name: "Пропускная способность" })
    .boundingBox();
  expect(headerBox?.y).toBeCloseTo(4, 0);
  expect(headerBox?.height).toBeCloseTo(48, 0);
  expect(metricBox?.y).toBeCloseTo(64, 0);
  expect(metricBox?.height).toBeCloseTo(69, 0);
  expect(latencyBox?.y).toBeCloseTo(222, 0);
  expect(latencyBox?.height).toBeCloseTo(161, 0);
  expect(throughputBox?.y).toBeCloseTo(395, 0);
  expect(throughputBox?.height).toBeCloseTo(155, 0);

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
    { viewport: 320, pageWidth: 288 },
    { viewport: 480, pageWidth: 448 },
    { viewport: 640, pageWidth: 608 },
    { viewport: 983, pageWidth: 671 },
    { viewport: 984, pageWidth: 672 },
    { viewport: 1079, pageWidth: 767 },
    { viewport: 1080, pageWidth: 768 },
  ];

  await page.setViewportSize({ width: cases[0].viewport, height: 844 });
  await openTraffic(page);

  for (const item of cases) {
    await page.setViewportSize({ width: item.viewport, height: 844 });
    const pageInlineSize = await page.locator(".responsive-page--traffic").evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        element.getBoundingClientRect().width -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight)
      );
    });
    expect(pageInlineSize).toBeCloseTo(item.pageWidth, 0);

    const inline = item.pageWidth >= 672;
    const data = item.pageWidth >= 768;
    const resetLabel = page.locator(".traffic-reset-label");
    if (inline) {
      await expect(resetLabel).toBeVisible();
    } else {
      await expect(resetLabel).toBeHidden();
    }
    const rootGaps = await page.locator(".responsive-page--traffic").evaluate((element) => {
      const children = Array.from(element.children);
      return children.slice(1).map((child, index) => {
        const previous = children[index];
        return child.getBoundingClientRect().top - (previous?.getBoundingClientRect().bottom ?? 0);
      });
    });
    expect(rootGaps.every((gap) => Math.abs(gap - (inline ? 22 : 12)) < 0.5)).toBe(true);
    await expect(page.locator(".traffic-charts")).toHaveCSS("row-gap", inline ? "22px" : "12px");
    await expect(page.locator(".traffic-metric-icon").first()).toHaveCSS(
      "display",
      inline ? "flex" : "none",
    );
    expect(
      await page
        .locator(".traffic-metrics")
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
    ).toBe(data ? 4 : 2);
    await expect(
      page.locator(
        data
          ? ".traffic-chart-variant--wide .traffic-latency-plot"
          : ".traffic-chart-variant--compact .traffic-latency-plot",
      ),
    ).toHaveCSS("height", data ? "150px" : "80px");
    await expectNoDocumentOverflow(page);
  }
});
