import { expect, type Page, test } from "@playwright/test";
import type { ChannelPoolMember, ProxyChannel, Source } from "@submerge/shared";
import {
  defaultChannelFixture,
  directChannelFixture,
  expectNoDocumentOverflow,
  installTrpcFixture,
  trpcFixtureByInput,
  trpcFixtureError,
} from "./fixtures";

const channel: ProxyChannel = {
  ...defaultChannelFixture,
  id: "work",
  name: "Работа",
  isDefault: false,
  policy: { kind: "manual", pinnedNode: "NL-1", onFailure: "hold" },
};
const source: Source = {
  id: 1,
  kind: "sub",
  value: "https://example.test/sub",
  label: "Европа",
  hwid: false,
  enabled: true,
  sortOrder: 0,
  meta: null,
  createdAt: "2026-10-07",
  updatedAt: "2026-10-07",
  proxies: ["NL-1", "DE-1"].map((name) => ({
    name,
    type: "vless",
    server: "example.test",
    port: 443,
    uuid: "00000000-0000-0000-0000-000000000001",
  })),
};
const inventory = {
  now: "AUTO",
  autoNow: "US-1",
  all: ["NL-1", "DE-1", "US-1", "AUTO", "ch-work", "hop"].map((name) => ({
    name,
    type: "vless",
    delay: 40,
    excluded: name === "hop",
  })),
};
const node = (ref: string): ChannelPoolMember => ({ kind: "node", ref });

async function setup(page: Page, members: ChannelPoolMember[], policy = channel.policy) {
  const overrides = {
    "channels.list": [directChannelFixture, { ...channel, policy }, defaultChannelFixture],
    "channels.getPool": trpcFixtureByInput((input) =>
      (input as { id: string }).id === "work" ? members : [],
    ),
    "sources.list": [source],
    "nodes.list": inventory,
    "channels.policyNodes":
      members.length === 0
        ? ["NL-1", "DE-1", "US-1"]
        : members.some((member) => member.kind === "source")
          ? ["NL-1", "DE-1"]
          : members
              .filter((member) => ["NL-1", "DE-1", "US-1"].includes(member.ref))
              .map((member) => member.ref),
    "channels.setPolicy": { channel, applied: true },
  };
  await installTrpcFixture(page, overrides);
  await page.goto("/routing");
  await expect(page).toHaveURL(/\/routing$/);
  await expect(page).toHaveTitle(/submerge/i);
  await page.getByRole("button", { name: "Развернуть канал «Работа»" }).first().click();
  return overrides;
}

async function candidates(page: Page) {
  return page
    .getByRole("combobox", { name: "Приоритетный узел" })
    .locator("option:not([disabled])")
    .allTextContents();
}

test("manual policy offers only individual pool nodes and persists the eligible choice", async ({
  page,
}) => {
  const overrides = await setup(page, [node("DE-1")]);
  page.on("request", (request) => {
    if (new URL(request.url()).pathname !== "/trpc/channels.setPolicy") return;
    const policy = request.postDataJSON()[0].policy;
    overrides["channels.list"] = [
      directChannelFixture,
      { ...channel, policy },
      defaultChannelFixture,
    ];
  });
  const select = page.getByRole("combobox", { name: "Приоритетный узел" });
  await expect(select).toHaveValue("");
  expect(await candidates(page)).toEqual(["DE-1"]);
  await expect(
    page.getByText("Сохранённый узел недоступен в пуле. Выберите другой."),
  ).toBeVisible();
  const request = page.waitForRequest(
    (r) => new URL(r.url()).pathname === "/trpc/channels.setPolicy",
  );
  await select.selectOption("DE-1");
  expect((await request).postDataJSON()[0]).toMatchObject({
    id: "work",
    policy: { kind: "manual", pinnedNode: "DE-1", onFailure: "hold" },
  });
  await expect(select).toHaveValue("DE-1");
});

test("manual policy switch seeds only from the resolved source pool", async ({ page }) => {
  await setup(page, [{ kind: "source", ref: "1" }], defaultChannelFixture.policy);
  const request = page.waitForRequest(
    (r) => new URL(r.url()).pathname === "/trpc/channels.setPolicy",
  );
  await page.getByRole("button", { name: "Приоритетный узел", exact: true }).click();
  expect((await request).postDataJSON()[0]).toMatchObject({
    id: "work",
    policy: { pinnedNode: "NL-1" },
  });
});

test("source pool includes its live nodes and excludes other sources and generated groups", async ({
  page,
}) => {
  await setup(page, [{ kind: "source", ref: "1" }]);
  await expect.poll(() => candidates(page)).toEqual(["NL-1", "DE-1"]);
});

test("a renamed engine target remains selectable through source membership", async ({ page }) => {
  await installTrpcFixture(page, {
    "channels.list": [
      directChannelFixture,
      { ...channel, policy: { ...channel.policy, pinnedNode: "AUTO-2" } },
      defaultChannelFixture,
    ],
    "channels.getPool": [{ kind: "source", ref: "1" }],
    "channels.policyNodes": ["AUTO-2"],
    "sources.list": [{ ...source, proxies: [{ ...source.proxies[0], name: "AUTO" }] }],
    "nodes.list": inventory,
  });
  await page.goto("/routing");
  await page.getByRole("button", { name: "Развернуть канал «Работа»" }).first().click();
  await expect.poll(() => candidates(page)).toEqual(["AUTO-2"]);
  await expect(page.getByRole("combobox", { name: "Приоритетный узел" })).toHaveValue("AUTO-2");
});

test("empty pool retains all eligible exit nodes", async ({ page }) => {
  await setup(page, []);
  await expect.poll(() => candidates(page)).toEqual(["NL-1", "DE-1", "US-1"]);
});

test("stale pool disables priority selection without offering a stale pin", async ({ page }) => {
  await setup(page, [node("gone")]);
  await expect(page.getByRole("combobox", { name: "Приоритетный узел" })).toBeDisabled();
  await expect(page.getByRole("option", { name: "Нет доступных узлов в пуле" })).toBeAttached();
});

test("priority candidates refresh after a pool checkbox write", async ({ page }) => {
  let members = [node("NL-1"), node("DE-1")];
  await installTrpcFixture(page, {
    "channels.list": [directChannelFixture, channel, defaultChannelFixture],
    "channels.getPool": trpcFixtureByInput(() => members),
    "channels.policyNodes": trpcFixtureByInput(() => members.map((member) => member.ref)),
    "channels.setPool": { ok: true, applied: true },
    "sources.list": [source],
    "nodes.list": inventory,
  });
  await page.goto("/routing");
  await page.getByRole("button", { name: "Развернуть канал «Работа»" }).first().click();
  await expect.poll(() => candidates(page)).toEqual(["NL-1", "DE-1"]);
  members = [node("DE-1")];
  await page.getByRole("checkbox", { name: "Включить узел «NL-1» в пул" }).click();
  await expect.poll(() => candidates(page)).toEqual(["DE-1"]);
  await expect(page.getByRole("combobox", { name: "Приоритетный узел" })).toHaveValue("");
});

test("a delayed refresh after restricting an empty pool hides the cached unrestricted candidates", async ({
  page,
}) => {
  let members: ChannelPoolMember[] = [];
  await installTrpcFixture(page, {
    "channels.list": [directChannelFixture, channel, defaultChannelFixture],
    "channels.getPool": trpcFixtureByInput(() => members),
    "channels.policyNodes": trpcFixtureByInput(() =>
      members.length ? ["DE-1"] : ["NL-1", "DE-1", "US-1"],
    ),
    "channels.setPool": { ok: true, applied: true },
    "sources.list": [source],
    "nodes.list": inventory,
  });
  let delayRefresh = false;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/trpc/**", async (route) => {
    if (delayRefresh && new URL(route.request().url()).pathname.includes("channels.policyNodes"))
      await pending;
    await route.fallback();
  });
  try {
    await page.goto("/routing");
    await page.getByRole("button", { name: "Развернуть канал «Работа»" }).first().click();
    await expect.poll(() => candidates(page)).toEqual(["NL-1", "DE-1", "US-1"]);
    members = [node("DE-1")];
    delayRefresh = true;
    await page.getByRole("checkbox", { name: "Включить узел «DE-1» в пул" }).click();
    const select = page.getByRole("combobox", { name: "Приоритетный узел" });
    await expect(select).toBeDisabled();
    await expect(select.locator("option")).toHaveText(["Сохранение пула узлов…"]);
    release();
    await expect.poll(() => candidates(page)).toEqual(["DE-1"]);
  } finally {
    release();
  }
});

test("periodic refresh retains eligible options while the unchanged projection loads", async ({
  page,
}) => {
  await setup(page, [node("DE-1")]);
  await expect.poll(() => candidates(page)).toEqual(["DE-1"]);
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/trpc/**", async (route) => {
    if (new URL(route.request().url()).pathname.includes("channels.policyNodes")) await pending;
    await route.fallback();
  });
  try {
    await page.waitForRequest((request) =>
      new URL(request.url()).pathname.includes("channels.policyNodes"),
    );
    const select = page.getByRole("combobox", { name: "Приоритетный узел" });
    await expect(select).toBeEnabled();
    expect(await candidates(page)).toEqual(["DE-1"]);
  } finally {
    release();
  }
});

for (const failed of [false, true]) {
  test(`pending pool write blocks old priority candidates and refreshes on ${failed ? "error" : "success"}`, async ({
    page,
  }) => {
    let members = [node("NL-1"), node("DE-1")];
    await installTrpcFixture(page, {
      "channels.list": [directChannelFixture, channel, defaultChannelFixture],
      "channels.getPool": trpcFixtureByInput(() => members),
      "channels.policyNodes": trpcFixtureByInput(() => members.map((member) => member.ref)),
      "channels.setPool": failed
        ? trpcFixtureError("reload failed after persistence")
        : { ok: true, applied: true },
      "sources.list": [source],
      "nodes.list": inventory,
    });
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/trpc/**", async (route) => {
      if (new URL(route.request().url()).pathname.includes("channels.setPool")) await pending;
      await route.fallback();
    });
    try {
      await page.goto("/routing");
      await page.getByRole("button", { name: "Развернуть канал «Работа»" }).first().click();
      await expect.poll(() => candidates(page)).toEqual(["NL-1", "DE-1"]);
      members = [node("DE-1")];
      await page.getByRole("checkbox", { name: "Включить узел «NL-1» в пул" }).click();
      const select = page.getByRole("combobox", { name: "Приоритетный узел" });
      await expect(select).toBeDisabled();
      await expect(select.locator("option")).toHaveText(["Сохранение пула узлов…"]);
      release();
      await expect.poll(() => candidates(page)).toEqual(["DE-1"]);
      await expect(select).toBeEnabled();
    } finally {
      release();
    }
  });
}

test("Default Settings applies the Default pool and ignores the active exit outside it", async ({
  page,
}) => {
  await installTrpcFixture(page, {
    "channels.getPool": [node("DE-1")],
    "channels.policyNodes": ["DE-1"],
    "sources.list": [source],
    "nodes.list": inventory,
    "channels.get": { ...defaultChannelFixture, policy: channel.policy },
  });
  await page.goto("/settings");
  await expect.poll(() => candidates(page)).toEqual(["DE-1"]);
  await expect(page.getByRole("combobox", { name: "Приоритетный узел" })).toHaveValue("");
});

test("failed pool query never exposes the unrestricted inventory", async ({ page }) => {
  await installTrpcFixture(page, {
    "channels.list": [directChannelFixture, channel, defaultChannelFixture],
    "channels.getPool": trpcFixtureError("fixture failure"),
    "channels.policyNodes": trpcFixtureError("fixture failure"),
    "sources.list": [source],
    "nodes.list": inventory,
  });
  await page.goto("/routing");
  await page.getByRole("button", { name: "Развернуть канал «Работа»" }).first().click();
  await expect(page.getByRole("combobox", { name: "Приоритетный узел" })).toBeDisabled();
  await expect(
    page.getByRole("option", { name: "Не удалось загрузить пул узлов." }),
  ).toBeAttached();
});

test("loading pool query cannot expose global nodes or write a priority pin", async ({ page }) => {
  await installTrpcFixture(page, {
    "channels.list": [directChannelFixture, channel, defaultChannelFixture],
    "channels.getPool": [node("DE-1")],
    "channels.policyNodes": ["DE-1"],
    "sources.list": [source],
    "nodes.list": inventory,
  });
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/trpc/**", async (route) => {
    if (new URL(route.request().url()).pathname.includes("channels.policyNodes")) await pending;
    await route.fallback();
  });
  try {
    await page.goto("/routing");
    await page.getByRole("button", { name: "Развернуть канал «Работа»" }).first().click();
    const select = page.getByRole("combobox", { name: "Приоритетный узел" });
    await expect(select).toBeDisabled();
    await expect(select.locator("option")).toHaveText(["Загрузка пула узлов…"]);
    release();
    await expect.poll(() => candidates(page)).toEqual(["DE-1"]);
    await expect(select).toBeEnabled();
  } finally {
    release();
  }
});

for (const width of [320, 390, 425, 768, 983, 984, 1024, 1440]) {
  test(`pool-aware priority control is contained and keyboard-accessible at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        (message.type() === "error" || message.type() === "warning") &&
        !message.text().includes("net::ERR_BLOCKED_BY_CLIENT")
      )
        errors.push(message.text());
    });
    await page.setViewportSize({ width, height: width === 1440 ? 1024 : 844 });
    await setup(page, [node("DE-1")]);
    const select = page.getByRole("combobox", { name: "Приоритетный узел" });
    await expect(select).toHaveValue("");
    await select.focus();
    await expect(select).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(select).not.toBeFocused();
    await expectNoDocumentOverflow(page);
    const measured = await select.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const parent = element.closest(".labeled-control-row-control")?.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        height: rect.height,
        radius: style.borderRadius,
        fontSize: style.fontSize,
        contained: parent != null && rect.left >= parent.left && rect.right <= parent.right + 1,
      };
    });
    expect(measured).toEqual({ height: 36, radius: "8px", fontSize: "16px", contained: true });
    expect(errors).toEqual([]);
    if (width === 1440 || width === 390) {
      await select.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/submerge-priority-pool-${width}-dark.png` });
    }
    if (width === 390) {
      await page.emulateMedia({ colorScheme: "light" });
      await expectNoDocumentOverflow(page);
      await page.screenshot({ path: "/tmp/submerge-priority-pool-390-light.png" });
    }
  });
}
