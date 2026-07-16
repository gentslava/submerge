import { expect, type Page, test } from "@playwright/test";
import type { LogEvent, LogStreamMessage } from "@submerge/shared";
import { expectNoDocumentOverflow, installTrpcFixture } from "./fixtures";

const events: LogEvent[] = [
  {
    id: 1,
    time: "2026-07-16T12:14:03.000Z",
    source: "mihomo",
    level: "info",
    message: "[TCP] 192.168.1.40 → discord.com:443 via nl-ams-01",
  },
  {
    id: 2,
    time: "2026-07-16T12:14:04.000Z",
    source: "submerge",
    level: "warning",
    message: "Конфигурация применится при следующей перезагрузке",
    fields: { scope: "config" },
  },
  {
    id: 3,
    time: "2026-07-16T12:14:05.000Z",
    source: "mihomo",
    level: "error",
    message: "dial failed",
    fields: { host: "api.example.test", port: 443 },
  },
  {
    id: 4,
    time: "2026-07-16T12:14:06.000Z",
    source: "submerge",
    level: "info",
    message: "submerge server started",
    fields: { host: "127.0.0.1", port: 3000 },
  },
];

function snapshot(snapshotEvents: readonly LogEvent[] = events): LogStreamMessage {
  return {
    type: "snapshot",
    cursor: snapshotEvents.length,
    upstream: "live",
    nextRetryAt: null,
    events: [...snapshotEvents],
  };
}

async function openLogs(
  page: Page,
  options: {
    messages?: readonly LogStreamMessage[];
    end?: "return" | "disconnect";
    colorScheme?: "dark" | "light";
  } = {},
): Promise<void> {
  await page.emulateMedia({ colorScheme: options.colorScheme ?? "dark" });
  await installTrpcFixture(
    page,
    {},
    {
      subscriptions: {
        "live.stream": { events: [] },
        "logs.stream": {
          events: options.messages ?? [snapshot()],
          ...(options.end ? { end: options.end } : {}),
        },
      },
    },
  );
  await page.goto("/logs");
  await expect(page.getByRole("heading", { name: "Логи" })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

test("populated dark desktop matches the dense Pencil timeline", async ({ page }) => {
  const browserProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      browserProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => browserProblems.push(`pageerror: ${error.message}`));
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openLogs(page);

  await expect(page.getByRole("button", { name: "Пауза" })).toContainText("Пауза");
  await expect(page.getByRole("button", { name: "Очистить" })).toContainText("Очистить");
  await expect(page.locator(".logs-row")).toHaveCount(4);
  await expect(page.locator(".logs-row").first()).toContainText("submerge server started");
  await expect(page.locator(".logs-row").last()).toContainText("discord.com:443");

  const root = page.locator(".responsive-page--logs");
  const rootGaps = await root.evaluate((element) => {
    const children = Array.from(element.children);
    return children.slice(1).map((child, index) => {
      const previous = children[index];
      return child.getBoundingClientRect().top - (previous?.getBoundingClientRect().bottom ?? 0);
    });
  });
  expect(rootGaps.every((gap) => Math.abs(gap - 22) < 0.5)).toBe(true);
  expect(
    await page
      .locator(".logs-row")
      .first()
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
  ).toBe(4);
  const rootBox = await root.boundingBox();
  const listBox = await page.locator(".logs-list").boundingBox();
  expect(rootBox?.y).toBeCloseTo(0, 0);
  expect(rootBox?.height).toBeCloseTo(1024, 0);
  expect(listBox?.y).toBeCloseTo(169, 0);
  expect((listBox?.y ?? 0) + (listBox?.height ?? 0)).toBeCloseTo(992, 0);
  expect(browserProblems).toEqual([]);
  await expectNoDocumentOverflow(page);
  await page.screenshot({ path: "/tmp/logs-dark-1440.png", fullPage: true });
});

test("light desktop uses the shared Indigo Console palette", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openLogs(page, { colorScheme: "light" });

  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.locator(".logs-list")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator(".logs-row").first()).toHaveCSS(
    "border-bottom-color",
    "rgb(230, 232, 239)",
  );
  await expectNoDocumentOverflow(page);
  await page.screenshot({ path: "/tmp/logs-light-1440.png", fullPage: true });
});

test("mobile uses compact actions, two filter rows, and stacked log rows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openLogs(page);

  await expect(page.getByRole("button", { name: "Пауза" })).toHaveCSS("width", "44px");
  await expect(page.getByRole("button", { name: "Очистить" })).toHaveCSS("width", "44px");
  await expect(page.locator(".logs-action-label").first()).toBeHidden();
  const rootWidth = await page.locator(".responsive-page--logs").evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      element.getBoundingClientRect().width -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight)
    );
  });
  expect(rootWidth).toBeCloseTo(358, 0);
  await expect(page.locator(".logs-search")).toHaveCSS("width", "358px");

  const sourceBox = await page.locator("#logs-source").boundingBox();
  const severityBox = await page.getByRole("group", { name: "Уровень" }).boundingBox();
  expect(sourceBox?.width).toBeCloseTo(142, 0);
  expect(sourceBox?.y).toBeCloseTo(severityBox?.y ?? 0, 0);
  expect((severityBox?.x ?? 0) + (severityBox?.width ?? 0)).toBeCloseTo(374, 0);

  const firstRow = page.locator(".logs-row").first();
  expect(
    await firstRow.evaluate(
      (element) => getComputedStyle(element).gridTemplateRows.split(" ").length,
    ),
  ).toBe(2);
  const timeBox = await firstRow.locator("time").boundingBox();
  const messageBox = await firstRow.locator(".logs-message").boundingBox();
  expect(messageBox?.y ?? 0).toBeGreaterThan(timeBox?.y ?? Infinity);
  await expectNoDocumentOverflow(page);
  await page.screenshot({ path: "/tmp/logs-mobile-390.png", fullPage: true });
});

test("empty, filtered-empty, and reconnecting states stay explicit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openLogs(page, { messages: [snapshot([])] });
  await expect(page.getByText("Событий пока нет")).toBeVisible();

  await openLogs(page);
  await page.getByRole("button", { name: "Пауза" }).click();
  await expect(page.getByRole("button", { name: "Продолжить" })).toBeVisible();
  await expect(page.locator(".logs-row")).toHaveCount(4);
  await page.screenshot({ path: "/tmp/logs-paused-390.png", fullPage: true });
  await page.getByLabel("Поиск в логах").fill("нет такого события");
  await expect(page.getByText("По фильтрам ничего не найдено")).toBeVisible();
  await page.getByRole("button", { name: "Сбросить фильтры" }).click();
  await expect(page.getByText("submerge server started")).toBeVisible();

  await openLogs(page, { messages: [snapshot()], end: "disconnect" });
  await expect(page.getByText("submerge server started")).toBeVisible();
  await expect(page.getByText(/показываем последние события/i)).toBeVisible({ timeout: 7_000 });
  await expect(page.getByText("submerge server started")).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test("Logs has no overflow at supported widths and its container boundary", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openLogs(page);

  for (const width of [320, 390, 425, 768, 983, 984, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1024 : 844 });
    await expectNoDocumentOverflow(page);
    const compact = width < 984;
    const label = page.locator(".logs-action-label").first();
    if (compact) await expect(label).toBeHidden();
    else await expect(label).toBeVisible();
  }
});
