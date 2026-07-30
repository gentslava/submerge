import { expect, test } from "@playwright/test";
import {
  expectNoDocumentOverflow,
  installTrpcFixture,
  trpcFixtureError,
  trpcFixtureSequence,
} from "./fixtures";

const populatedConnections = {
  connections: [
    {
      id: "connection-1",
      source: "Safari",
      host: "api.very-long-development-service.example.com",
      destIp: "203.0.113.10",
      port: "443",
      network: "tcp",
      node: "DIRECT",
      up: 2048,
      down: 4096,
      start: "2026-07-12T08:00:00.000Z",
    },
    {
      id: "connection-2",
      source: "192.168.1.50",
      host: "github.com",
      destIp: "140.82.121.4",
      port: "443",
      network: "tcp",
      node: "Амстердам — основной маршрут",
      up: 1024,
      down: 8192,
      start: "2026-07-12T08:05:00.000Z",
    },
  ],
};

const connectionSources = [
  {
    id: 1,
    kind: "sub",
    value: "https://example.test/subscription",
    label: "Основная подписка",
    hwid: false,
    enabled: true,
    sortOrder: 0,
    proxies: [
      {
        name: "Амстердам — основной маршрут",
        type: "vless",
        server: "example.test",
        port: 443,
      },
    ],
    meta: null,
    updatedAt: "2026-07-12T08:00:00.000Z",
    createdAt: "2026-07-12T08:00:00.000Z",
  },
];

test("connections keep search compact beside the destructive action on desktop", async ({
  page,
}) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/connections");

  const search = page.locator(".connections-search");
  const closeAll = page.locator(".connections-close-all");
  const searchBox = await search.boundingBox();
  const closeBox = await closeAll.boundingBox();

  expect(searchBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(searchBox?.width).toBeLessThanOrEqual(240);
  expect(closeBox?.y).toBe(searchBox?.y);
  await expectNoDocumentOverflow(page);
});

test("connections reserve full-width rows for phone controls only", async ({ page }) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/connections");

  const searchBox = await page.locator(".connections-search").boundingBox();
  const closeBox = await page.locator(".connections-close-all").boundingBox();

  expect(searchBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(closeBox?.y).toBeGreaterThan(searchBox?.y ?? 0);
  expect(Math.abs((searchBox?.width ?? 0) - (closeBox?.width ?? 0))).toBeLessThanOrEqual(1);
  await expectNoDocumentOverflow(page);
});

test("connections use the available content pane rather than the viewport for toolbar rows", async ({
  page,
}) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 768, height: 844 });
  await page.goto("/connections");

  const searchBox = await page.locator(".connections-search").boundingBox();
  const closeBox = await page.locator(".connections-close-all").boundingBox();

  expect(searchBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  if (!searchBox || !closeBox)
    throw new Error("Expected connections toolbar geometry to be measurable");
  expect(closeBox.y).toBeGreaterThan(searchBox.y);
  expect(Math.abs(searchBox.width - closeBox.width)).toBeLessThanOrEqual(1);
  await expectNoDocumentOverflow(page);
});

for (const width of [320, 390]) {
  test(`populated connections keep their mobile cards reachable at ${width}px`, async ({
    page,
  }) => {
    await installTrpcFixture(page, {
      "connections.list": trpcFixtureSequence(populatedConnections, {
        connections: populatedConnections.connections.map((connection) => ({
          ...connection,
          up: connection.up + 1,
          down: connection.down + 1,
        })),
      }),
      "sources.list": connectionSources,
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/connections");

    const mobile = page.locator(".connections-table-mobile");
    const destination = mobile.getByText("api.very-long-development-service.example.com:443");
    await expect(destination).toBeVisible();
    await expect(destination).toHaveAttribute(
      "title",
      "api.very-long-development-service.example.com:443",
    );
    await expect(
      mobile.getByText("Амстердам — основной маршрут", { exact: true }).first(),
    ).toHaveAttribute("title", "Основная подписка — Амстердам — основной маршрут");
    await expect(mobile.getByText("DIRECT", { exact: true })).toHaveAttribute("title", "DIRECT");

    const unitLabel = mobile.getByText("КБ/С", { exact: true }).first();
    await expect(mobile.getByText("КБ/С", { exact: true })).toHaveCount(2);
    expect(
      await unitLabel.evaluate((element) => {
        const label = element.getBoundingClientRect();
        const metric = element.parentElement?.getBoundingClientRect();
        return metric !== undefined && label.left >= metric.left && label.right <= metric.right;
      }),
    ).toBe(true);
    const speedValue = mobile.locator(".mobile-connection-speed > span").nth(1);
    await expect(speedValue).toHaveText("↓ <0.01 ↑ <0.01", { timeout: 4_000 });
    expect(await speedValue.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );

    await expect(mobile.getByRole("button", { name: "Разорвать соединение" })).toHaveCount(2);
    await expectNoDocumentOverflow(page);
  });
}

test("populated connections keep their desktop rows and actions reachable", async ({ page }) => {
  await installTrpcFixture(page, {
    "connections.list": populatedConnections,
    "sources.list": connectionSources,
  });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/connections");

  const desktop = page.locator(".connections-table-desktop");
  await expect(desktop).toBeVisible();
  await expect(page.locator(".connections-table-mobile")).toBeHidden();
  await expect(
    desktop.getByText("api.very-long-development-service.example.com:443"),
  ).toHaveAttribute("title", "api.very-long-development-service.example.com:443");
  await expect(
    desktop.getByText("Амстердам — основной маршрут", { exact: true }).first(),
  ).toHaveAttribute("title", "Основная подписка — Амстердам — основной маршрут");
  await expect(desktop.getByText("DIRECT", { exact: true })).toHaveAttribute("title", "DIRECT");
  await expect(desktop.getByText("Скорость, КБ/с", { exact: true })).toBeVisible();
  await expect(desktop.getByRole("button", { name: "Разорвать соединение" })).toHaveCount(2);
  await expectNoDocumentOverflow(page);
});

test("kilobyte rates stay inside the fixed desktop column at high values", async ({ page }) => {
  await installTrpcFixture(page, {
    "connections.list": trpcFixtureSequence(populatedConnections, {
      connections: populatedConnections.connections.map((connection) => ({
        ...connection,
        up: connection.up + 2_097_152,
        down: connection.down + 2_097_152,
      })),
    }),
    "sources.list": connectionSources,
  });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/connections");

  const rate = page.locator(".connections-table-desktop .connection-speed").first();
  await expect(rate).toHaveText("↓ 0.00 ↑ 0.00");
  const beforeUpdate = await rate.boundingBox();
  expect(beforeUpdate).not.toBeNull();
  await expect(rate).not.toHaveText("↓ 0.00 ↑ 0.00", { timeout: 4_000 });
  const afterUpdate = await rate.boundingBox();
  expect(afterUpdate).not.toBeNull();
  expect(afterUpdate?.x).toBe(beforeUpdate?.x);
  expect(afterUpdate?.width).toBe(beforeUpdate?.width);
  expect(await rate.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expectNoDocumentOverflow(page);
});

for (const width of [390, 1440]) {
  test(`connections expose the first-load error state at ${width}px`, async ({ page }) => {
    await installTrpcFixture(page, {
      "connections.list": trpcFixtureError("mihomo unavailable"),
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    await page.goto("/connections");

    await expect(page.getByText("Движок недоступен", { exact: true })).toBeVisible();
    const state = page.locator(
      width === 390 ? ".connections-table-mobile" : ".connections-table-desktop",
    );
    await expect(
      state.getByText("Движок недоступен — не удалось получить соединения"),
    ).toBeVisible();
    await expectNoDocumentOverflow(page);
  });
}
