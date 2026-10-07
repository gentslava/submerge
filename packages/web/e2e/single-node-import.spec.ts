import { expect, type Page, test } from "@playwright/test";
import { addSourceInput, type Source } from "@submerge/shared";
import { ingestSource } from "../../server/src/modules/sources/ingest.js";
import { xrayConfig } from "../../server/src/modules/sources/single-node.fixture.js";
import { expectNoDocumentOverflow, installTrpcFixture } from "./fixtures";

const configText = JSON.stringify(xrayConfig, null, 2);
const staticSource: Source = {
  id: 1,
  kind: "node",
  value: configText,
  label: "My single node with a long descriptive name",
  hwid: false,
  enabled: true,
  sortOrder: 0,
  proxies: [{ name: "My single node", type: "vless", server: "203.0.113.1", port: 443 }],
  meta: null,
  updatedAt: "2026-10-07T00:00:00Z",
  createdAt: "2026-10-07T00:00:00Z",
};

async function importFixture(page: Page, initial: Source[] = []) {
  const sources = [...initial];
  const inputs: unknown[] = [];
  await installTrpcFixture(page, { "sources.list": sources });
  // Exercise the actual ingest parser on the form's posted input; GET/SSE remain
  // populated fixtures so these tests do not alter a running installation.
  await page.route("**/trpc/sources.add*", async (route) => {
    const raw = route.request().postDataJSON();
    const input = addSourceInput.parse(raw["0"]?.json ?? raw["0"] ?? raw.json ?? raw);
    inputs.push(input);
    try {
      const result = await ingestSource(input.value);
      const source: Source = {
        ...staticSource,
        id: sources.length + 1,
        value: input.value,
        kind: result.kind,
        label: result.label,
        proxies: result.proxies,
      };
      sources.push(source);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([
          { result: { data: { source, applied: true, skipped: result.skipped } } },
        ]),
      });
    } catch (error) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify([
          {
            error: {
              message: error instanceof Error ? error.message : "Invalid config",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: "sources.add" },
            },
          },
        ]),
      });
    }
  });
  return { sources, inputs };
}

for (const width of [320, 390, 425, 768, 991, 992, 993, 1024, 1440]) {
  test(`one-node form and populated static rows fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1024 : 844 });
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT"))
        consoleErrors.push(message.text());
    });
    await importFixture(page, [staticSource, { ...staticSource, id: 2, enabled: false }]);
    await page.goto("/sources");
    await expect(page.getByRole("heading", { name: "Источники", exact: true })).toBeVisible();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    const input = page.getByLabel("Ссылка источника");
    await input.fill(configText);
    await expect(page.getByText("один узел · JSON / YAML")).toBeVisible();
    await expect(page.getByLabel("Передавать HWID")).toHaveCount(0);
    await expect(page.getByText("статический конфиг")).toHaveCount(2);
    await expect(input).toHaveCSS("height", "120px");
    await expect(page.locator(".source-form-submit-button")).toHaveCSS("height", "40px");
    await expect(page.locator("section").first()).toHaveCSS("border-radius", "10px");
    await expectNoDocumentOverflow(page);
    const boxes = await page
      .locator("textarea, .source-form-submit-button, .source-row-controls")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        }),
      );
    expect(boxes.every((box) => box.left >= 0 && box.right <= width)).toBe(true);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    if (width === 1440 || width === 390)
      await page.screenshot({ path: `/tmp/submerge-single-node-${width}-dark.png` });
  });
}

test("paste adds exactly one static node and excludes HWID", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  const fixture = await importFixture(page);
  await page.goto("/sources");
  await expect(page.getByText("Пока нет источников", { exact: false })).toBeVisible();
  await page.getByRole("switch", { name: "Передавать HWID" }).click();
  await page.getByLabel("Ссылка источника").fill(configText);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.getByText("Источник добавлен", { exact: true })).toBeVisible();
  await expect(page.locator(".source-row")).toHaveCount(1);
  await expect(page.getByText("1 узел", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Перечитать конфиг" })).toBeVisible();
  expect(fixture.inputs).toEqual([{ value: configText, hwid: false }]);
  expect(fixture.sources[0]?.kind).toBe("node");
  expect(fixture.sources[0]?.proxies).toHaveLength(1);
  await expect(page.getByLabel("Ссылка источника")).toHaveValue("");
});

test("file picker and file drop recognize JSON and YAML with no extra control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await importFixture(page);
  await page.goto("/sources");
  const picker = page.locator('input[type="file"]');
  await picker.setInputFiles({
    name: "single-node.json",
    mimeType: "application/json",
    buffer: Buffer.from(configText),
  });
  await expect(page.getByLabel("Ссылка источника")).toHaveValue(configText);
  await expect(page.getByText("один узел · JSON / YAML")).toBeVisible();
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.locator(".source-row")).toHaveCount(1);
  const yaml =
    "name: YAML node\ntype: trojan\nserver: example.test\nport: 443\npassword: synthetic-password\n";
  await page.getByLabel("Ссылка источника").evaluate((element, content) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], "node.yaml", { type: "application/yaml" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  }, yaml);
  await expect(page.getByLabel("Ссылка источника")).toHaveValue(yaml);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.locator(".source-row")).toHaveCount(2);
  await expect(page.getByText("YAML node", { exact: true })).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test("multiple nodes produce a real validation error and keep the input", async ({ page }) => {
  await importFixture(page);
  await page.goto("/sources");
  const value = JSON.stringify({ outbounds: [xrayConfig.outbounds[0], xrayConfig.outbounds[0]] });
  await page.getByLabel("Ссылка источника").fill(value);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(
    page.getByText("Конфиг должен содержать ровно один прокси-узел", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Ссылка источника")).toHaveValue(value);
  await expect(page.locator(".source-row")).toHaveCount(0);
  await expectNoDocumentOverflow(page);
});

test("large files leave the previous input intact and report the limit", async ({ page }) => {
  await importFixture(page);
  await page.goto("/sources");
  await page.getByLabel("Ссылка источника").fill(configText);
  await page.locator('input[type="file"]').setInputFiles({
    name: "large.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(512_001),
  });
  await expect(
    page.getByText("Файл слишком большой для конфига источника", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Ссылка источника")).toHaveValue(configText);
});

test("malformed JSON produces a syntax error without clearing the form", async ({ page }) => {
  await importFixture(page);
  await page.goto("/sources");
  const value = '{"outbounds": [';
  await page.getByLabel("Ссылка источника").fill(value);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(
    page.getByText("Некорректный JSON/YAML: проверьте синтаксис конфига", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Ссылка источника")).toHaveValue(value);
  await expect(page.locator(".source-row")).toHaveCount(0);
});

test("automatic detection retains keyboard focus and fits the light theme", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await importFixture(page, [staticSource]);
  await page.goto("/sources");
  const input = page.getByLabel("Ссылка источника");
  await input.focus();
  await input.fill(configText);
  await expect(input).toBeFocused();
  await page.keyboard.press("Tab");
  // The visually hidden file input precedes its visible button in keyboard order.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Выбрать файл" })).toBeFocused();
  await expectNoDocumentOverflow(page);
  await page.screenshot({ path: "/tmp/submerge-single-node-320-light.png" });
});
