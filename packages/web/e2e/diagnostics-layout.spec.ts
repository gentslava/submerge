import { expect, type Page, test } from "@playwright/test";
import type { DiagnosticsResult } from "@submerge/shared";
import {
  expectNoDocumentOverflow,
  installTrpcFixture,
  trpcFixtureError,
  trpcFixtureSequence,
} from "./fixtures";

const healthyResult: DiagnosticsResult = {
  startedAt: "2026-07-16T08:00:00.000Z",
  completedAt: "2026-07-16T08:00:02.000Z",
  durationMs: 2_000,
  state: "ready",
  summary: "4 из 4 маршрутов · 6 из 6 сервисов",
  components: [
    {
      id: "submerge",
      status: "ok",
      durationMs: 12,
      version: "0.2.0",
      detail: "SQLite доступна",
      errorCode: null,
    },
    {
      id: "mihomo",
      status: "ok",
      durationMs: 4,
      version: "v1.19.12",
      detail: "Контроллер доступен",
      errorCode: null,
    },
    {
      id: "happ-decoder",
      status: "ok",
      durationMs: 18,
      version: null,
      detail: "Доступен",
      errorCode: null,
    },
  ],
  externalIp: {
    status: "ok",
    ip: "185.107.56.42",
    country: "NL",
    colo: "AMS",
    durationMs: 84,
    route: "AUTO",
    node: "nl-ams-01",
    detail: "Внешний IP определён",
    errorCode: null,
  },
  routes: [
    ["default", "Default", "www.gstatic.com", "nl-ams-01", 48],
    ["youtube", "YouTube", "youtube.com", "de-fra-02", 52],
    ["telegram", "Telegram", "t.me", "nl-ams-01", 61],
    ["ai", "AI", "chatgpt.com", "de-fra-02", 70],
  ].map(([channelId, channelName, targetHost, node, durationMs]) => ({
    channelId: String(channelId),
    channelName: String(channelName),
    targetHost: String(targetHost),
    node: String(node),
    status: "ok" as const,
    durationMs: Number(durationMs),
    detail: "Маршрут доступен",
    errorCode: null,
  })),
  services: [
    ["google", "Google", 44],
    ["youtube", "YouTube", 52],
    ["telegram", "Telegram", 61],
    ["cloudflare", "Cloudflare", 39],
    ["chatgpt", "ChatGPT", 70],
    ["steam", "Steam", 88],
  ].map(([id, label, durationMs]) => ({
    id: id as DiagnosticsResult["services"][number]["id"],
    label: String(label),
    status: "ok" as const,
    durationMs: Number(durationMs),
    httpStatus: 200,
    detail: "Доступен",
    errorCode: null,
  })),
  config: {
    status: "ok",
    proxyEndpoint: "127.0.0.1:7890",
    mode: "rule",
    dns: true,
    ipv6: false,
    tun: false,
    errorCode: null,
  },
};

async function openDiagnostics(
  page: Page,
  response:
    | DiagnosticsResult
    | ReturnType<typeof trpcFixtureError>
    | ReturnType<typeof trpcFixtureSequence> = healthyResult,
  colorScheme: "dark" | "light" = "dark",
): Promise<void> {
  await page.emulateMedia({ colorScheme });
  await installTrpcFixture(page, { "diagnostics.run": response });
  await page.goto("/diagnostics");
  await expect(page.getByRole("heading", { name: "Диагностика" })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

test("populated dark desktop matches the approved diagnostics hierarchy", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openDiagnostics(page);

  await expect(page.getByRole("link", { name: "Диагностика" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Проверить снова" })).toContainText(
    "Проверить снова",
  );
  expect(
    await page
      .locator(".diagnostics-overview-grid")
      .first()
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
  ).toBe(2);
  expect(
    await page
      .locator(".diagnostics-details-grid")
      .first()
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
  ).toBe(2);
  await expect(page.getByRole("table", { name: "Маршруты" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Маршруты" })).toBeHidden();

  const routesBox = await page.getByLabel("Проверка маршрутов").boundingBox();
  const servicesBox = await page.getByLabel("Доступность сервисов").boundingBox();
  const configBox = await page.getByLabel("Конфигурация mihomo").boundingBox();
  expect(routesBox?.x ?? Infinity).toBeLessThan(servicesBox?.x ?? -Infinity);
  expect(configBox?.x).toBe(routesBox?.x);
  expect(configBox?.y ?? -Infinity).toBeGreaterThan(routesBox?.y ?? Infinity);

  await page.screenshot({ path: "/tmp/diagnostics-dark-1440.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

test("light desktop uses the shared Indigo Console tokens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openDiagnostics(page, healthyResult, "light");

  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.getByLabel("Внешний IP")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.getByRole("table", { name: "Маршруты" })).toBeVisible();
  await page.screenshot({ path: "/tmp/diagnostics-light-1440.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

test("manual refresh retains the old snapshot, prevents duplicates, then replaces it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const refreshed: DiagnosticsResult = {
    ...healthyResult,
    completedAt: "2026-07-16T08:05:00.000Z",
    summary: "Обновлённый результат",
    externalIp: { ...healthyResult.externalIp, ip: "203.0.113.5" },
  };
  await openDiagnostics(page, trpcFixtureSequence(healthyResult, refreshed));

  let releaseRefresh = () => {};
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let forcedRequests = 0;
  await page.route("**/trpc/diagnostics.run**", async (route) => {
    const input = new URL(route.request().url()).searchParams.get("input");
    if (input?.includes("true")) {
      forcedRequests++;
      await refreshGate;
    }
    await route.fallback();
  });

  await page.getByRole("button", { name: "Проверить снова" }).click();
  await expect(page.getByRole("button", { name: "Проверить снова" })).toBeDisabled();
  await expect(page.getByText("Проверка выполняется")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Обновляем результаты");
  await expect(page.getByRole("status")).toHaveCSS("position", "absolute");
  await expect(page.getByText("185.107.56.42")).toBeVisible();
  await expect(page.getByText("203.0.113.5")).toBeHidden();
  expect(forcedRequests).toBe(1);

  releaseRefresh();
  await expect(page.getByText("203.0.113.5")).toBeVisible();
  await expect(page.getByText("Обновлённый результат")).toBeVisible();
  await expect(page.getByRole("button", { name: "Проверить снова" })).toBeEnabled();
  expect(forcedRequests).toBe(1);
});

test("mobile preserves the approved block order and compact route list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1_500 });
  await openDiagnostics(page);

  await expect(page.getByRole("button", { name: "Проверить снова" })).toHaveCSS("width", "358px");
  await expect(page.locator(".diagnostics-refresh-label")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ещё" })).toHaveClass(/active/);
  await expect(page.getByRole("table", { name: "Маршруты" })).toBeHidden();
  await expect(page.getByRole("list", { name: "Маршруты" })).toBeVisible();

  const routesBox = await page.getByLabel("Проверка маршрутов").boundingBox();
  const servicesBox = await page.getByLabel("Доступность сервисов").boundingBox();
  const configInitialBox = await page.getByLabel("Конфигурация mihomo").boundingBox();
  expect(routesBox?.y ?? Infinity).toBeLessThan(servicesBox?.y ?? -Infinity);
  expect(servicesBox?.y ?? Infinity).toBeLessThan(configInitialBox?.y ?? -Infinity);

  await page.screenshot({ path: "/tmp/diagnostics-mobile-390.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Конфигурация mihomo").scrollIntoViewIfNeeded();
  await expect(page.getByLabel("Конфигурация mihomo")).toBeVisible();
  const configVisibleBox = await page.getByLabel("Конфигурация mihomo").boundingBox();
  const navBox = await page.locator("nav.fixed").boundingBox();
  expect((configVisibleBox?.y ?? Infinity) + (configVisibleBox?.height ?? 0)).toBeLessThanOrEqual(
    navBox?.y ?? -Infinity,
  );
  await expectNoDocumentOverflow(page);
});

test("first load exposes progress until the initial result completes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await installTrpcFixture(page, { "diagnostics.run": healthyResult });
  let releaseInitial = () => {};
  const initialGate = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  await page.route("**/trpc/**", async (route) => {
    if (!route.request().url().includes("diagnostics.run")) {
      await route.fallback();
      return;
    }
    await initialGate;
    await route.fallback();
  });

  await page.goto("/diagnostics");
  await expect(page.getByText("Выполняем первичную проверку")).toBeVisible();
  await expect(page.getByRole("button", { name: "Проверить снова" })).toBeDisabled();
  releaseInitial();
  await expect(page.getByText("Все проверки пройдены")).toBeVisible();
});

test("exceptional states, skipped counts, and safe long values stay local", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const longChannel = "Очень длинное имя канала, которое должно обрезаться только внутри строки";
  const longNode = "очень-длинное-имя-узла-которое-должно-оставаться-доступным";
  const longHost = "очень-длинное-имя-хоста-которое-должно-оставаться-доступным.example.com";
  const longProxyEndpoint = "очень-длинное-имя-прокси-которое-должно-оставаться-доступным:7890";
  const [firstRoute, secondRoute, ...remainingRoutes] = healthyResult.routes;
  if (!firstRoute || !secondRoute) throw new Error("route fixtures are incomplete");
  const partial: DiagnosticsResult = {
    ...healthyResult,
    state: "partial",
    summary: "2 из 3 маршрутов · 5 из 5 сервисов",
    routes: [
      {
        ...firstRoute,
        channelName: longChannel,
        targetHost: longHost,
        node: longNode,
        status: "failed",
        durationMs: null,
        detail: "Тайм-аут проверки через канал",
        errorCode: "timeout",
      },
      {
        ...secondRoute,
        status: "skipped",
        durationMs: null,
        detail: "Нет активного узла",
        errorCode: "no-active-node",
      },
      ...remainingRoutes,
    ],
    services: healthyResult.services.map((service, index) =>
      index === 0
        ? {
            ...service,
            status: "skipped",
            durationMs: null,
            httpStatus: null,
            detail: "mihomo недоступен",
            errorCode: "dependency-unavailable",
          }
        : service,
    ),
    config: { ...healthyResult.config, proxyEndpoint: longProxyEndpoint },
  };
  await openDiagnostics(page, partial);
  await expect(page.getByText("Есть замечания")).toBeVisible();
  await expect(page.getByText("2 / 3")).toBeVisible();
  await expect(page.getByText("5 / 5")).toBeVisible();
  const compactRoutes = page.getByRole("list", { name: "Маршруты" });
  await expect(compactRoutes.getByText("Тайм-аут проверки через канал")).toBeVisible();
  await expect(compactRoutes.getByText("Ошибка").last()).toBeVisible();
  const channelValue = compactRoutes.getByTitle(longChannel);
  const hostValue = compactRoutes.getByTitle(longHost);
  const nodeValue = compactRoutes.getByTitle(longNode);
  const configValue = page.getByLabel("Конфигурация mihomo").getByTitle(longProxyEndpoint);
  await expect(channelValue).toBeVisible();
  await channelValue.focus();
  await expect(channelValue).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(hostValue).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(nodeValue).toBeFocused();
  await configValue.focus();
  await expect(configValue).toBeFocused();

  for (const [state, title] of [
    ["mihomo-down", "mihomo недоступен"],
    ["external-ip-unavailable", "Внешний IP не определён"],
    ["no-internet", "Нет выхода в интернет"],
  ] as const) {
    await openDiagnostics(page, { ...healthyResult, state });
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
});

test("no-nodes and first-load errors remain explicit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDiagnostics(page, {
    ...healthyResult,
    state: "no-nodes",
    summary: "Прокси-узлы отсутствуют",
    routes: [],
    externalIp: {
      ...healthyResult.externalIp,
      status: "skipped",
      ip: null,
      country: null,
      colo: null,
      durationMs: null,
      route: null,
      node: null,
      detail: "Нет активного прокси-узла",
      errorCode: "no-active-node",
    },
  });
  await expect(page.getByText("Нет прокси-узлов")).toBeVisible();
  await expect(page.getByText("Маршруты не проверялись")).toBeVisible();

  await openDiagnostics(page, trpcFixtureError("diagnostics unavailable"));
  await expect(page.getByText("Не удалось запустить диагностику")).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить" })).toBeVisible();
});

test("Diagnostics has no overflow at supported widths and container boundaries", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openDiagnostics(page);

  for (const width of [320, 390, 425, 768, 983, 984, 1024, 1079, 1080, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1024 : 844 });
    await expectNoDocumentOverflow(page);
    await expect(page.locator(".diagnostics-refresh-label")).toBeVisible();
    const headerBox = await page.locator(".page-header").boundingBox();
    const refreshBox = await page.getByRole("button", { name: "Проверить снова" }).boundingBox();
    if (width < 984) {
      expect(refreshBox?.width).toBe(headerBox?.width);
    } else {
      expect(refreshBox?.width ?? Infinity).toBeLessThan(headerBox?.width ?? -Infinity);
    }
    if (width < 1080) {
      await expect(page.getByRole("table", { name: "Маршруты" })).toBeHidden();
    } else {
      await expect(page.getByRole("table", { name: "Маршруты" })).toBeVisible();
    }
  }
});
