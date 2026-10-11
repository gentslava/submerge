import { createGatewayDraft, gatewayProfileSchema } from "@submerge/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NetworkSettingsForm } from "./NetworkSettingsSection";

const configuration = {
  profile: { profile: "proxy" as const },
  tun: createGatewayDraft(),
  availableLists: ["notblocked.txt"],
  prerequisites: [{ name: "tun-access", ok: null }],
  connection: { lanAddress: null, dnsAddress: null, dnsPort: 1053, access: "bridge" as const },
};
const readiness = {
  profile: "proxy" as const,
  ready: true,
  checks: [{ name: "runtime", ok: true }],
};

describe("native network settings", () => {
  it("refreshes untouched settings in the same mode before autosaving another field", () => {
    const apply = vi.fn();
    const tun = gatewayProfileSchema.parse({
      ...createGatewayDraft(),
      localResolvers: ["192.168.1.1"],
    });
    const props = {
      configuration: { ...configuration, profile: tun, tun },
      readiness,
      pending: false,
      checking: false,
      error: null,
      onApply: apply,
      onCheck: vi.fn(),
    };
    const { rerender } = render(<NetworkSettingsForm {...props} />);
    fireEvent.click(screen.getByText("Дополнительные настройки"));
    const refreshed = { ...tun, mtu: 1400 };
    rerender(
      <NetworkSettingsForm
        {...props}
        configuration={{ ...props.configuration, profile: refreshed, tun: refreshed }}
      />,
    );
    expect(screen.getByRole("spinbutton", { name: "MTU, байт" })).toHaveProperty("value", "1400");
    const dns = screen.getByRole("textbox", { name: "Локальный DNS" });
    fireEvent.change(dns, { target: { value: "192.168.1.7" } });
    fireEvent.blur(dns);
    expect(apply).toHaveBeenCalledWith({ ...refreshed, localResolvers: ["192.168.1.7"] });
  });
  it("preserves invalid and unfinished fields while refreshing untouched settings", () => {
    const apply = vi.fn();
    const tun = gatewayProfileSchema.parse({
      ...createGatewayDraft(),
      localResolvers: ["192.168.1.1"],
    });
    const props = {
      configuration: { ...configuration, profile: tun, tun },
      readiness,
      pending: false,
      checking: false,
      error: null,
      onApply: apply,
      onCheck: vi.fn(),
    };
    const { rerender } = render(<NetworkSettingsForm {...props} />);
    fireEvent.click(screen.getByText("Дополнительные настройки"));
    fireEvent.change(screen.getByRole("spinbutton", { name: "MTU, байт" }), {
      target: { value: "1000" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Внешние DNS" }), {
      target: { value: `${tun.nameservers.join("\n")}\n` },
    });
    const refreshed = { ...tun, mtu: 1400, dnsPort: 1153 };
    rerender(
      <NetworkSettingsForm
        {...props}
        configuration={{ ...props.configuration, profile: refreshed, tun: refreshed }}
      />,
    );
    expect(screen.getByRole("spinbutton", { name: "MTU, байт" })).toHaveProperty("value", "1000");
    expect(screen.getByRole("textbox", { name: "Внешние DNS" })).toHaveProperty(
      "value",
      `${tun.nameservers.join("\n")}\n`,
    );
    expect(screen.getByRole("spinbutton", { name: "DNS-порт" })).toHaveProperty("value", "1153");
    expect(apply).not.toHaveBeenCalled();
    const refreshedAgain = { ...refreshed, dnsPort: 1253 };
    rerender(
      <NetworkSettingsForm
        {...props}
        configuration={{ ...props.configuration, profile: refreshedAgain, tun: refreshedAgain }}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Внешние DNS" })).toHaveProperty(
      "value",
      `${tun.nameservers.join("\n")}\n`,
    );
  });
  it("does not activate TUN on a Proxy pointer click when the browser blurs DNS without a focus target", () => {
    const apply = vi.fn();
    render(
      <NetworkSettingsForm
        configuration={configuration}
        readiness={readiness}
        pending={false}
        checking={false}
        error={null}
        onApply={apply}
        onCheck={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "TUN" }));
    const dns = screen.getByRole("textbox", { name: "Локальный DNS" });
    fireEvent.change(dns, { target: { value: "192.168.1.7" } });
    const proxy = screen.getByRole("button", { name: "Прокси" });
    fireEvent.pointerDown(proxy);
    fireEvent.blur(dns, { relatedTarget: null });
    fireEvent.click(proxy);
    expect(apply).not.toHaveBeenCalled();
  });
  it("requires independent local DNS on first TUN selection and activates automatically on blur", () => {
    const apply = vi.fn();
    render(
      <NetworkSettingsForm
        configuration={configuration}
        readiness={readiness}
        pending={false}
        checking={false}
        error={null}
        onApply={apply}
        onCheck={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "TUN" }));
    expect(apply).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByRole("textbox", { name: "Локальный DNS" }));
    expect(screen.getByRole("alert").textContent).toContain("локальный DNS");
    expect(apply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Локальный DNS" }), {
      target: { value: "192.168.1.1" },
    });
    fireEvent.blur(screen.getByRole("textbox", { name: "Локальный DNS" }));
    expect(apply).toHaveBeenCalledWith(
      gatewayProfileSchema.parse({ ...configuration.tun, localResolvers: ["192.168.1.1"] }),
    );
  });
  it("restores retained TUN preferences and keeps failed apply visible", () => {
    const apply = vi.fn();
    const tun = gatewayProfileSchema.parse({
      ...createGatewayDraft(),
      localResolvers: ["192.168.1.9"],
      mtu: 1400,
    });
    render(
      <NetworkSettingsForm
        configuration={{ ...configuration, tun }}
        readiness={{ ...readiness, ready: false }}
        pending={false}
        checking={false}
        error="Движок отклонил конфигурацию"
        onApply={apply}
        onCheck={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Движок отклонил");
    fireEvent.click(screen.getByRole("button", { name: "TUN" }));
    expect(screen.getByRole("textbox", { name: "Локальный DNS" })).toHaveProperty(
      "value",
      "192.168.1.9",
    );
    expect(apply).toHaveBeenCalledWith(tun);
  });
});
