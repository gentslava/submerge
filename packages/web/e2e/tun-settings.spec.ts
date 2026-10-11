import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createGatewayDraft, gatewayProfileSchema, type NetworkProfile } from "@submerge/shared";
import {
  expectNoDocumentOverflow,
  type FixtureOverrides,
  installTrpcFixture,
  trpcFixtureByInput,
  trpcFixtureError,
} from "./fixtures";

const tun = gatewayProfileSchema.parse({
  ...createGatewayDraft(),
  localResolvers: ["192.168.1.1"],
  privateLists: [
    { name: "notblocked", file: "notblocked.txt", target: "notblocked", behavior: "domain" },
    { name: "custom", file: "custom.txt", target: "proxy", behavior: "domain" },
  ],
});
function configuration(profile: NetworkProfile = tun) {
  return {
    profile,
    tun: profile.profile === "gateway" ? profile : tun,
    availableLists: [
      "notblocked.txt",
      "custom.txt",
      "a-very-long-published-file-name-for-responsive-container-verification.txt",
    ],
    prerequisites: [
      { name: "admin-password", ok: true },
      { name: "engine-secret", ok: true },
      { name: "network", ok: true },
      { name: "private-lists", ok: true },
      { name: "tun-access", ok: null },
    ],
    connection: {
      lanAddress: "192.168.1.2",
      dnsAddress: "192.168.1.2:1053",
      dnsPort: 1053,
      access: "lan",
    },
  };
}
const ready = {
  profile: "gateway",
  ready: true,
  checks: [
    { name: "runtime", ok: true },
    { name: "vpn-pool", ok: true },
    { name: "dns-upstream", ok: true },
  ],
};
function fixtures(): FixtureOverrides {
  const overrides: FixtureOverrides = {
    "gateway.configuration": configuration(),
    "gateway.readiness": ready,
    "settings.set": { applied: true },
  };
  overrides["gateway.set"] = trpcFixtureByInput((input) => {
    const profile = input as NetworkProfile;
    const previous = overrides["gateway.configuration"] as ReturnType<typeof configuration>;
    const nextTun = profile.profile === "gateway" ? profile : previous.tun;
    overrides["gateway.configuration"] = {
      ...previous,
      profile,
      tun: nextTun,
      connection: {
        ...previous.connection,
        dnsPort: nextTun.dnsPort,
        dnsAddress: nextTun.dnsListen === "0.0.0.0" ? `192.168.1.2:${nextTun.dnsPort}` : null,
      },
    };
    overrides["gateway.readiness"] = { ...ready, profile: profile.profile };
    return { nodes: 2, applied: true, activationVerified: true };
  });
  return overrides;
}

for (const width of [320, 390, 425, 768, 983, 985, 1024, 1440]) {
  test(`TUN settings fit ${width}px collapsed and expanded in both themes`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1024 });
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await installTrpcFixture(page, fixtures());
    await page.goto("/settings");
    const section = page.getByRole("region", { name: "Режим подключения", exact: true });
    await expect(section.getByText("TUN работает", { exact: true })).toBeVisible();
    await expect(section.getByRole("textbox", { name: "Внешние DNS", exact: true })).toBeHidden();
    await expectNoDocumentOverflow(page);
    if (width === 983 || width === 985)
      await expect(section.locator(".labeled-control-row").first()).toHaveCSS(
        "flex-direction",
        width === 983 ? "column" : "row",
      );
    if (width === 1440) {
      const metrics = await section.evaluate((element) => {
        const read = (selector: string) =>
          Array.from(element.querySelectorAll<HTMLElement>(selector)).map((node) => {
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              text: node.textContent,
              width: box.width,
              height: box.height,
              font: style.fontSize,
              weight: style.fontWeight,
              padding: style.padding,
              radius: style.borderRadius,
              color: style.color,
            };
          });
        return {
          heading: read("h2"),
          mode: read(".segmented-control--stretch"),
          buttons: read(".segmented-control--stretch > button"),
          inputs: read("input"),
          rows: read(".labeled-control-row"),
        };
      });
      writeFileSync("/tmp/submerge-tun-ui-metrics.json", JSON.stringify(metrics, null, 2));
      expect(metrics.buttons.map((button) => button.font)).toEqual(["13px", "13px"]);
      expect(metrics.heading[0]?.font).toBe("15px");
      expect(metrics.mode[0]?.width).toBe(260);
    }
    if (width === 1440 || width === 390)
      await page.screenshot({ path: `/tmp/submerge-tun-ui-${width}-dark.png` });
    await section.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(section.getByRole("textbox", { name: "Внешние DNS", exact: true })).toBeVisible();
    await section
      .getByRole("combobox", { name: "Добавить опубликованный список" })
      .selectOption("a-very-long-published-file-name-for-responsive-container-verification.txt");
    await section.getByRole("button", { name: "Добавить", exact: true }).click();
    await expect(
      section.getByText(
        "a-very-long-published-file-name-for-responsive-container-verification.txt",
        { exact: true },
      ),
    ).toBeVisible();
    await expectNoDocumentOverflow(page);
    await page.getByRole("button", { name: "Светлая", exact: true }).click();
    await expectNoDocumentOverflow(page);
    await section.locator("summary").click();
    await expectNoDocumentOverflow(page);
    expect(errors).toEqual([]);
  });
}

test("first-time TUN waits for local DNS; valid mode selection applies immediately and retains preferences", async ({
  page,
}) => {
  const overrides = fixtures();
  overrides["gateway.configuration"] = {
    ...configuration({ profile: "proxy" }),
    tun: createGatewayDraft(),
  };
  overrides["gateway.readiness"] = {
    profile: "proxy",
    ready: true,
    checks: [{ name: "runtime", ok: true }],
  };
  const submitted: NetworkProfile[] = [];
  overrides["gateway.set"] = trpcFixtureByInput((input) => {
    const next = input as NetworkProfile;
    submitted.push(next);
    const previous = overrides["gateway.configuration"] as ReturnType<typeof configuration>;
    overrides["gateway.configuration"] = {
      ...previous,
      profile: next,
      tun: next.profile === "gateway" ? next : previous.tun,
    };
    overrides["gateway.readiness"] = { ...ready, profile: next.profile };
    return { nodes: 2, applied: true, activationVerified: true };
  });
  await installTrpcFixture(page, overrides);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Режим подключения", exact: true });
  await section.getByRole("button", { name: "TUN", exact: true }).click();
  expect(submitted).toEqual([]);
  await expect(section.getByText("Прокси работает", { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "Применить", exact: true })).toHaveCount(0);
  await section.getByRole("textbox", { name: "Локальный DNS", exact: true }).focus();
  await section.getByRole("textbox", { name: "Локальный DNS", exact: true }).blur();
  await expect(section.getByRole("alert")).toContainText("локальный DNS");
  expect(submitted).toEqual([]);
  await section.getByRole("textbox", { name: "Локальный DNS", exact: true }).fill("192.168.1.7");
  await section.getByRole("textbox", { name: "Локальный DNS", exact: true }).blur();
  await expect(section.getByText("TUN работает", { exact: true })).toBeVisible();
  expect(submitted[0]).toMatchObject({
    profile: "gateway",
    localResolvers: ["192.168.1.7"],
    nameservers: createGatewayDraft().nameservers,
  });
  await section.getByRole("button", { name: "Прокси", exact: true }).click();
  await expect(section.getByText("Прокси работает", { exact: true })).toBeVisible();
  expect(submitted[1]).toEqual({ profile: "proxy" });
  await section.getByRole("button", { name: "TUN", exact: true }).click();
  await expect(section.getByRole("textbox", { name: "Локальный DNS", exact: true })).toHaveValue(
    "192.168.1.7",
  );
});

test("leaving local DNS for Proxy does not activate TUN and pending activation disables controls", async ({
  page,
}) => {
  const overrides = fixtures();
  overrides["gateway.configuration"] = {
    ...configuration({ profile: "proxy" }),
    tun: createGatewayDraft(),
  };
  overrides["gateway.readiness"] = {
    profile: "proxy",
    ready: true,
    checks: [{ name: "runtime", ok: true }],
  };
  const submitted: NetworkProfile[] = [];
  overrides["gateway.set"] = trpcFixtureByInput((input) => {
    const next = input as NetworkProfile;
    submitted.push(next);
    overrides["gateway.configuration"] = {
      ...configuration(next),
      tun: next.profile === "gateway" ? next : tun,
    };
    overrides["gateway.readiness"] = { ...ready, profile: next.profile };
    return { nodes: 2, applied: true, activationVerified: true };
  });
  await installTrpcFixture(page, overrides);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Режим подключения", exact: true });
  await section.getByRole("button", { name: "TUN", exact: true }).click();
  await section.getByRole("textbox", { name: "Локальный DNS", exact: true }).fill("192.168.1.7");
  await section.getByRole("button", { name: "Прокси", exact: true }).click();
  await expect(section.getByRole("textbox", { name: "Локальный DNS", exact: true })).toHaveCount(0);
  expect(submitted).toEqual([]);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/trpc/**", async (route) => {
    if (route.request().method() === "POST" && route.request().url().includes("gateway.set"))
      await gate;
    await route.fallback();
  });
  await section.getByRole("button", { name: "TUN", exact: true }).click();
  await expect(section.getByRole("button", { name: "Прокси", exact: true })).toBeDisabled();
  await expect(section.getByRole("textbox", { name: "Локальный DNS", exact: true })).toBeDisabled();
  release();
  await expect(section.getByText("TUN работает", { exact: true })).toBeVisible();
  expect(submitted).toHaveLength(1);
});

test("advanced fields save on blur, reject invalid drafts, and selects apply without closing details", async ({
  page,
}) => {
  const overrides = fixtures();
  const submitted: NetworkProfile[] = [];
  overrides["gateway.set"] = trpcFixtureByInput((input) => {
    const next = input as NetworkProfile;
    submitted.push(next);
    overrides["gateway.configuration"] = {
      ...configuration(next),
      tun: next.profile === "gateway" ? next : tun,
    };
    return { nodes: 2, applied: true, activationVerified: true };
  });
  await installTrpcFixture(page, overrides);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Режим подключения", exact: true });
  await section.locator("summary").click();
  const mtu = section.getByRole("spinbutton", { name: "MTU, байт", exact: true });
  await mtu.fill("1000");
  await mtu.blur();
  await expect(section.getByRole("alert")).toContainText("MTU");
  expect(submitted).toEqual([]);
  await mtu.fill("1400");
  expect(submitted).toEqual([]);
  await mtu.blur();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({ mtu: 1400 });
  await expect(mtu).toBeVisible();
  await expect(section.getByRole("combobox", { name: "Стек TUN", exact: true })).toBeEnabled();
  await section.getByRole("combobox", { name: "Стек TUN", exact: true }).selectOption("system");
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted[1]).toMatchObject({ tunStack: "system", mtu: 1400 });
  await expect(mtu).toBeVisible();
  await expect(section.getByRole("button", { name: "Применить", exact: true })).toHaveCount(0);
});

test("apply failure remains visible and can be retried without claiming TUN activation", async ({
  page,
}) => {
  const overrides = fixtures();
  overrides["gateway.configuration"] = configuration({ profile: "proxy" });
  overrides["gateway.readiness"] = {
    profile: "proxy",
    ready: true,
    checks: [{ name: "runtime", ok: true }],
  };
  let attempts = 0;
  overrides["gateway.set"] = trpcFixtureByInput(() => {
    attempts++;
    if (attempts === 1) return trpcFixtureError("TUN device unavailable");
    overrides["gateway.configuration"] = configuration();
    overrides["gateway.readiness"] = ready;
    return { nodes: 2, applied: true, activationVerified: true };
  });
  await installTrpcFixture(page, overrides);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Режим подключения", exact: true });
  await section.getByRole("button", { name: "TUN", exact: true }).click();
  await expect(section.getByRole("alert")).toContainText("TUN device unavailable");
  await expect(section.getByText("Прокси работает", { exact: true })).toBeVisible();
  await expect(section.getByText("TUN работает", { exact: true })).toHaveCount(0);
  await section.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(section.getByText("TUN работает", { exact: true })).toBeVisible();
  await expect(section.getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(2);
});

test("same-mode refresh updates untouched fields without overwriting newer settings or unfinished drafts", async ({
  page,
}) => {
  const overrides = fixtures();
  const submitted: NetworkProfile[] = [];
  overrides["gateway.set"] = trpcFixtureByInput((input) => {
    const next = input as NetworkProfile;
    submitted.push(next);
    overrides["gateway.configuration"] = configuration(next);
    return { nodes: 2, applied: true, activationVerified: true };
  });
  await installTrpcFixture(page, overrides);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Режим подключения", exact: true });
  await section.locator("summary").click();
  const mtu = section.getByRole("spinbutton", { name: "MTU, байт", exact: true });
  await expect(mtu).toHaveValue("1500");
  overrides["gateway.configuration"] = configuration({ ...tun, mtu: 1400 });
  await section.getByRole("button", { name: "Проверить", exact: true }).click();
  await expect(mtu).toHaveValue("1400");
  const dns = section.getByRole("textbox", { name: "Локальный DNS", exact: true });
  await dns.fill("192.168.1.7");
  await dns.blur();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({ mtu: 1400, localResolvers: ["192.168.1.7"] });
  await expect(mtu).toBeEnabled();
  await mtu.fill("1000");
  overrides["gateway.configuration"] = configuration({
    ...tun,
    mtu: 1450,
    localResolvers: ["192.168.1.7"],
    nameservers: ["1.1.1.1"],
  });
  await section.getByRole("button", { name: "Проверить", exact: true }).click();
  await expect(section.getByRole("textbox", { name: "Внешние DNS", exact: true })).toHaveValue(
    "1.1.1.1",
  );
  await expect(mtu).toHaveValue("1000");
  await expect(mtu).toBeVisible();
  expect(submitted).toHaveLength(1);
});

test("shows missing deployment, empty VPN and DNS/list faults with a truthful bridge guide", async ({
  page,
}) => {
  const overrides = fixtures();
  overrides["gateway.configuration"] = {
    ...configuration(),
    availableLists: [],
    prerequisites: [
      { name: "network", ok: false },
      { name: "tun-access", ok: null },
    ],
    connection: { lanAddress: "172.30.220.2", dnsAddress: null, dnsPort: 1053, access: "bridge" },
  };
  overrides["gateway.readiness"] = {
    profile: "gateway",
    ready: false,
    checks: ["tun-interface", "vpn-pool", "dns-upstream", "private-lists"].map((name) => ({
      name,
      ok: false,
    })),
  };
  await installTrpcFixture(page, overrides);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Режим подключения", exact: true });
  await expect(section.getByText("Режим не подтверждён", { exact: true })).toBeVisible();
  await expect(section.getByText("Доступные VPN-ноды", { exact: true })).toBeVisible();
  await expect(section.getByText("Внешний DNS", { exact: true })).toBeVisible();
  await expect(
    section.getByText("LAN-адрес для устройств ещё не подготовлен.", { exact: false }),
  ).toBeVisible();
  await expect(section.getByText("172.30.220.2", { exact: false })).toHaveCount(0);
  await section.locator("summary").click();
  await expect(section.getByText("Опубликованных файлов нет.", { exact: false })).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test("load and stale readiness errors are visible and retryable", async ({ page }) => {
  const overrides = fixtures();
  overrides["gateway.configuration"] = trpcFixtureError("configuration unavailable");
  await installTrpcFixture(page, overrides);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Режим подключения", exact: true });
  await expect(section.getByRole("alert")).toContainText("Не удалось загрузить");
  overrides["gateway.configuration"] = configuration();
  await section.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(section.getByText("TUN работает", { exact: true })).toBeVisible();
  overrides["gateway.readiness"] = trpcFixtureError("engine unavailable");
  await section.getByRole("button", { name: "Проверить", exact: true }).click();
  await expect(section.getByText("Проверка недоступна", { exact: true })).toBeVisible();
  await expect(section.getByText("TUN работает", { exact: true })).toHaveCount(0);
});

test("loopback-only DNS is never advertised or copied as LAN DNS and failed saved TUN keeps the caveat", async ({
  page,
}) => {
  const overrides = fixtures();
  overrides["gateway.configuration"] = {
    ...configuration(),
    tun: { ...tun, dnsListen: "127.0.0.1" },
    connection: { lanAddress: "192.168.1.2", dnsAddress: null, dnsPort: 1053, access: "lan" },
  };
  overrides["gateway.readiness"] = {
    profile: "gateway",
    ready: false,
    checks: [{ name: "runtime", ok: false }],
  };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (value: string) => {
          sessionStorage.setItem("copied-addresses", value);
          return Promise.resolve();
        },
      },
    });
  });
  await installTrpcFixture(page, overrides);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Режим подключения", exact: true });
  await expect(section.getByText("DNS не слушает на LAN-адресе.", { exact: false })).toBeVisible();
  await expect(
    section.getByText("Подключайте устройства после успешного применения TUN и проверок.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(section.getByText("DNS для AdGuard:", { exact: false })).toHaveCount(0);
  await section.getByRole("button", { name: "Скопировать адреса", exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("copied-addresses"))).toBe(
    "Шлюз: 192.168.1.2",
  );
});

test("advanced DNS preserves line breaks and exact notblocked provider definitions", async ({
  page,
}) => {
  const overrides = fixtures();
  let submitted: unknown;
  overrides["gateway.set"] = trpcFixtureByInput((input) => {
    submitted = input;
    return { nodes: 0, applied: false, activationVerified: false };
  });
  await installTrpcFixture(page, overrides);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Режим подключения", exact: true });
  await section.locator("summary").click();
  const dns = section.getByRole("textbox", { name: "Внешние DNS", exact: true });
  await dns.fill("1.1.1.1");
  await dns.press("End");
  await dns.press("Enter");
  await dns.pressSequentially("8.8.8.8");
  await expect(dns).toHaveValue("1.1.1.1\n8.8.8.8");
  await expect(
    section.getByRole("combobox", { name: "Формат notblocked.txt", exact: true }),
  ).toBeDisabled();
  await dns.blur();
  await expect(section.getByRole("alert")).toContainText("режим не применён");
  expect(submitted).toMatchObject({
    nameservers: ["1.1.1.1", "8.8.8.8"],
    privateLists: tun.privateLists,
  });
});
