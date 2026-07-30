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

const desktopColumnFractions = {
  source: 1.5,
  destination: 1.9,
  type: 0.4,
  node: 1.65,
  speed: 1.8,
  time: 0.65,
} as const;

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

for (const width of [320, 390, 416, 425]) {
  test(`populated connections keep their mobile cards reachable at ${width}px`, async ({
    page,
  }) => {
    await installTrpcFixture(page, {
      "connections.list": trpcFixtureSequence(populatedConnections, {
        connections: populatedConnections.connections.map((connection) => ({
          ...connection,
          up: connection.up + 4_194_304,
          down: connection.down + 4_194_304,
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

    const speed = mobile.locator(".mobile-connection-speed").first();
    const speedBoxBeforeUpdate = await speed.boundingBox();
    expect(speedBoxBeforeUpdate).not.toBeNull();
    expect(speedBoxBeforeUpdate?.width).toBe(96);
    await expect(speed.getByText("СКОРОСТЬ", { exact: true })).toBeVisible();
    expect(
      await speed.evaluate((element) => {
        const label = element.getBoundingClientRect();
        const metric = element.parentElement?.getBoundingClientRect();
        return metric !== undefined && label.left >= metric.left && label.right <= metric.right;
      }),
    ).toBe(true);

    const directions = speed.locator(".connection-speed-direction");
    await expect(directions).toHaveCount(2);
    await expect(directions.nth(0).getByText("Скачивание", { exact: true })).toHaveClass("sr-only");
    await expect(directions.nth(1).getByText("Отдача", { exact: true })).toHaveClass("sr-only");
    await expect(directions.nth(0).locator(".connection-speed-arrow")).toHaveText("↓");
    await expect(directions.nth(1).locator(".connection-speed-arrow")).toHaveText("↑");
    await expect(speed.locator(".connection-speed-unit")).toHaveText(["Б/с", "Б/с"]);
    await expect(speed.locator(".connection-speed-unit")).toHaveText(["МБ/с", "МБ/с"], {
      timeout: 4_000,
    });
    await expect(
      mobile
        .locator("article")
        .first()
        .getByText(/^\d+:\d{2}:\d{2}$/),
    ).toBeVisible();
    expect(
      await speed.evaluate((element) => {
        const label = element
          .querySelector(".mobile-connection-speed-label")
          ?.getBoundingClientRect();
        const rows = [...element.querySelectorAll(".connection-speed-direction")].map((row) =>
          row.getBoundingClientRect(),
        );
        if (!label || rows.length !== 2) return false;
        const labelCenter = (label.left + label.right) / 2;
        return rows.every((row) => Math.abs((row.left + row.right) / 2 - labelCenter) < 0.5);
      }),
    ).toBe(true);
    const speedBoxAfterUpdate = await speed.boundingBox();
    expect(speedBoxAfterUpdate).not.toBeNull();
    expect(Math.abs((speedBoxAfterUpdate?.x ?? 0) - (speedBoxBeforeUpdate?.x ?? 0))).toBeLessThan(
      0.5,
    );
    expect(speedBoxAfterUpdate?.width).toBe(speedBoxBeforeUpdate?.width);
    for (const direction of await directions.all()) {
      expect(
        await direction.evaluate((element) => {
          const arrow = element.querySelector(".connection-speed-arrow")?.getBoundingClientRect();
          const value = element.querySelector(".connection-speed-value")?.getBoundingClientRect();
          const unit = element.querySelector(".connection-speed-unit")?.getBoundingClientRect();
          return (
            arrow !== undefined &&
            value !== undefined &&
            unit !== undefined &&
            value.right <= unit.left &&
            unit.right <= arrow.left &&
            element.scrollWidth <= element.clientWidth
          );
        }),
      ).toBe(true);
    }

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
  for (const column of ["Тип", "Скорость"]) {
    await expect(desktop.getByText(column, { exact: true })).toHaveCSS("text-align", "center");
  }
  await expect(desktop.getByText("Источник", { exact: true })).toHaveCSS("text-align", "left");
  await expect(desktop.getByText("Назначение", { exact: true })).toHaveCSS("text-align", "left");
  await expect(desktop.getByText("Узел", { exact: true })).toHaveCSS("text-align", "left");
  await expect(desktop.getByText("Время", { exact: true })).toHaveCSS("text-align", "right");

  const firstRow = desktop.locator(".connection-row").first();
  const sourceColumn = firstRow.locator(".connection-source-column");
  const destinationColumn = firstRow.locator(".connection-destination-column");
  const typeColumn = firstRow.locator(".connection-type-column");
  const nodeColumn = firstRow.locator(".connection-node-column");
  const timeColumn = firstRow.locator(".connection-time-column");
  await expect(sourceColumn).toHaveCSS("text-align", "left");
  await expect(destinationColumn).toHaveCSS("text-align", "left");
  await expect(typeColumn).toHaveCSS("text-align", "center");
  await expect(nodeColumn).toHaveCSS("justify-content", "flex-start");
  await expect(nodeColumn).toHaveCSS("padding-left", "16px");
  await expect(timeColumn).toHaveCSS("text-align", "right");

  const sourceBox = await sourceColumn.boundingBox();
  const destinationBox = await destinationColumn.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(destinationBox).not.toBeNull();
  const destinationToSourceRatio =
    (destinationBox?.width ?? 0) / (sourceBox?.width ?? Number.POSITIVE_INFINITY);
  expect(destinationToSourceRatio).toBeGreaterThan(1.24);
  expect(destinationToSourceRatio).toBeLessThan(1.3);

  for (const name of ["source", "destination", "type", "node", "speed", "time"] as const) {
    const headerBox = await desktop.locator(`.connections-${name}-header`).boundingBox();
    const rowBox = await firstRow.locator(`.connection-${name}-column`).boundingBox();
    expect(headerBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(rowBox?.x).toBe(headerBox?.x);
    expect(rowBox?.width).toBe(headerBox?.width);
  }
  await expect(desktop.getByRole("button", { name: "Разорвать соединение" })).toHaveCount(2);
  await expectNoDocumentOverflow(page);
});

test("proportional connection grid fits without a table scrollbar at 1171px", async ({ page }) => {
  await installTrpcFixture(page, {
    "connections.list": populatedConnections,
    "sources.list": connectionSources,
  });
  await page.setViewportSize({ width: 1171, height: 800 });
  await page.goto("/connections");

  const desktop = page.locator(".connections-table-desktop");
  await expect(desktop).toBeVisible();
  expect(
    await desktop.evaluate((element) => {
      return element.scrollWidth <= element.clientWidth;
    }),
  ).toBe(true);
  const row = desktop.locator(".connection-row").first();
  await expect(desktop.locator(".connection-row")).toHaveCount(2);
  const sourceBox = await row.locator(".connection-source-column").boundingBox();
  expect(sourceBox).not.toBeNull();
  for (const [name, fraction] of Object.entries(desktopColumnFractions)) {
    const box = await row.locator(`.connection-${name}-column`).boundingBox();
    expect(box).not.toBeNull();
    expect((box?.width ?? 0) / (sourceBox?.width ?? Number.POSITIVE_INFINITY)).toBeCloseTo(
      fraction / desktopColumnFractions.source,
      1,
    );
  }
  expect(
    await row
      .locator(".connection-time-column")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const tableBox = await desktop.boundingBox();
  const actionBox = await row.getByRole("button", { name: "Разорвать соединение" }).boundingBox();
  expect(tableBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  expect(actionBox?.x ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(tableBox?.x ?? 0);
  expect((actionBox?.x ?? 0) + (actionBox?.width ?? 0)).toBeLessThanOrEqual(
    (tableBox?.x ?? 0) + (tableBox?.width ?? 0),
  );
  await expectNoDocumentOverflow(page);
});

test("all desktop connection columns grow proportionally on a 4K viewport", async ({ page }) => {
  await installTrpcFixture(page, {
    "connections.list": populatedConnections,
    "sources.list": connectionSources,
  });
  await page.setViewportSize({ width: 1171, height: 800 });
  await page.goto("/connections");

  const table = page.locator(".connections-table-desktop");
  const row = table.locator(".connection-row").first();
  const compactWidths = Object.fromEntries(
    await Promise.all(
      Object.keys(desktopColumnFractions).map(async (name) => {
        const box = await row.locator(`.connection-${name}-column`).boundingBox();
        return [name, box?.width ?? 0];
      }),
    ),
  );

  await page.setViewportSize({ width: 3840, height: 2160 });

  const pageRoot = page.locator(".connections-screen");
  const tableBox = await table.boundingBox();
  const pageBox = await pageRoot.boundingBox();
  expect(tableBox).not.toBeNull();
  expect(pageBox).not.toBeNull();
  expect((tableBox?.x ?? 0) - (pageBox?.x ?? 0)).toBe(32);
  expect((pageBox?.width ?? 0) - (tableBox?.width ?? 0)).toBe(64);
  const sourceBox = await row.locator(".connection-source-column").boundingBox();
  expect(sourceBox).not.toBeNull();
  for (const [name, fraction] of Object.entries(desktopColumnFractions)) {
    const box = await row.locator(`.connection-${name}-column`).boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan((compactWidths[name] ?? 0) * 2);
    expect((box?.width ?? 0) / (sourceBox?.width ?? Number.POSITIVE_INFINITY)).toBeCloseTo(
      fraction / desktopColumnFractions.source,
      1,
    );
  }
  const destinationBox = await row.locator(".connection-destination-column").boundingBox();
  expect(destinationBox).not.toBeNull();
  const sourceWidth = sourceBox?.width ?? 0;
  const destinationWidth = destinationBox?.width ?? 0;
  expect(destinationWidth / sourceWidth).toBeGreaterThan(1.24);
  expect(destinationWidth / sourceWidth).toBeLessThan(1.3);
  await expectNoDocumentOverflow(page);
});

test("pending speed rows align with the desktop header", async ({ page }) => {
  await installTrpcFixture(page);
  await page.route("**/trpc/**", async (route) => {
    if (route.request().url().includes("connections.list")) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/connections");

  const header = page.locator(".connections-speed-header");
  const skeleton = page.locator(".connections-speed-skeleton").first();
  await expect(header).toBeVisible();
  await expect(skeleton).toBeVisible();
  const headerBox = await header.boundingBox();
  const skeletonBox = await skeleton.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(skeletonBox).not.toBeNull();
  expect(skeletonBox?.width).toBe(headerBox?.width);
  expect(skeletonBox?.x).toBe(headerBox?.x);
});

test("dynamic rates stay inside the proportional desktop column at its narrow boundary", async ({
  page,
}) => {
  await installTrpcFixture(page, {
    "connections.list": trpcFixtureSequence(populatedConnections, {
      connections: populatedConnections.connections.map((connection) => ({
        ...connection,
        up: connection.up + 2_097_152,
        down: connection.down + 2_097_152,
        start: new Date(Date.now() - 23 * 3_600_000).toISOString(),
      })),
    }),
    "sources.list": connectionSources,
  });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/connections");
  await page.evaluate(() => document.fonts.ready);

  const rate = page.locator(".connections-table-desktop .connection-speed").first();
  const speedFontSize = await rate.evaluate((element) => getComputedStyle(element).fontSize);
  await expect(rate).toHaveCSS("flex-direction", "row");
  await expect(rate.getByText("Скачивание", { exact: true })).toHaveClass("sr-only");
  await expect(rate.getByText("Отдача", { exact: true })).toHaveClass("sr-only");
  const directions = rate.locator(".connection-speed-direction");
  await expect(directions).toHaveCount(2);
  await expect(directions.nth(0).locator(".connection-speed-arrow")).toHaveText("↓");
  await expect(directions.nth(1).locator(".connection-speed-arrow")).toHaveText("↑");
  const units = rate.locator(".connection-speed-unit");
  await expect(units).toHaveText(["Б/с", "Б/с"]);
  for (const direction of await directions.all()) {
    expect(
      await direction.evaluate((element) => {
        const arrow = element.querySelector(".connection-speed-arrow")?.getBoundingClientRect();
        const value = element.querySelector(".connection-speed-value")?.getBoundingClientRect();
        const unit = element.querySelector(".connection-speed-unit")?.getBoundingClientRect();
        return (
          arrow !== undefined &&
          value !== undefined &&
          unit !== undefined &&
          value.right <= unit.left &&
          unit.right <= arrow.left
        );
      }),
    ).toBe(true);
  }
  const visualGap = await rate.evaluate((element) => {
    const firstArrow = element
      .querySelectorAll(".connection-speed-arrow")[0]
      ?.getBoundingClientRect();
    const secondValue = element.querySelectorAll(".connection-speed-value")[1];
    if (!firstArrow || !secondValue) return null;
    const valueText = document.createRange();
    valueText.selectNodeContents(secondValue);
    return valueText.getBoundingClientRect().left - firstArrow.right;
  });
  expect(visualGap).not.toBeNull();
  expect(visualGap ?? 0).toBeGreaterThanOrEqual(11);
  expect(visualGap ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(13);
  const expectPairCentered = async () => {
    const centerOffset = await rate.evaluate((element) => {
      const outer = element.getBoundingClientRect();
      const groups = element.querySelectorAll(".connection-speed-direction");
      const first = groups[0]?.getBoundingClientRect();
      const last = groups[groups.length - 1]?.getBoundingClientRect();
      if (!first || !last) return null;
      return (first.left + last.right) / 2 - (outer.left + outer.right) / 2;
    });
    expect(centerOffset).not.toBeNull();
    expect(Math.abs(centerOffset ?? Number.POSITIVE_INFINITY)).toBeLessThan(0.5);
  };
  await expectPairCentered();
  const beforeUpdate = await rate.boundingBox();
  expect(beforeUpdate).not.toBeNull();
  await expect(units).toHaveText(["МБ/с", "МБ/с"], { timeout: 4_000 });
  expect(await rate.evaluate((element) => getComputedStyle(element).fontSize)).toBe(speedFontSize);
  const afterUpdate = await rate.boundingBox();
  expect(afterUpdate).not.toBeNull();
  expect(afterUpdate?.x).toBe(beforeUpdate?.x);
  expect(afterUpdate?.width).toBe(beforeUpdate?.width);
  await expectPairCentered();
  const desktopTime = page.locator(".connections-table-desktop .connection-time-column").first();
  await expect(desktopTime).toHaveText(/^\d{1,2}:\d{2}$/);
  await expect(desktopTime).toHaveAttribute("title", /^\d{1,2}:\d{2}:\d{2}$/);
  expect(await rate.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  for (const width of [1080, 1144, 1192, 1239]) {
    await page.setViewportSize({ width, height: 1024 });
    await page.evaluate(() => document.fonts.ready);
    await expect(rate).toHaveCSS("flex-direction", "column");
    expect(await rate.evaluate((element) => getComputedStyle(element).fontSize)).toBe(
      speedFontSize,
    );
    const directionTops = await directions.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().top),
    );
    expect(directionTops[1]).toBeGreaterThan(directionTops[0] ?? 0);
    const speedMetrics = await rate.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(speedMetrics.scrollWidth, `speed must fit at viewport ${width}px`).toBeLessThanOrEqual(
      speedMetrics.clientWidth,
    );
    const timeMetrics = await desktopTime.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(timeMetrics.scrollWidth, `time must fit at viewport ${width}px`).toBeLessThanOrEqual(
      timeMetrics.clientWidth,
    );
  }

  await page.setViewportSize({ width: 1240, height: 1024 });
  await page.evaluate(() => document.fonts.ready);
  await expect(rate).toHaveCSS("flex-direction", "row");
  expect(await rate.evaluate((element) => getComputedStyle(element).fontSize)).toBe(speedFontSize);
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
