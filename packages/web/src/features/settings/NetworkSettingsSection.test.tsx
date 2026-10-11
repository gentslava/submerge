import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { NetworkSettingsForm } from "./NetworkSettingsSection";

const configuration = { mode: "proxy" as const, localResolvers: [] };
const props = {
  configuration,
  pending: false,
  pendingMode: undefined,
  error: null,
  onApply: vi.fn(),
};
it("applies TUN immediately without a DNS requirement and keeps selection until confirmed", () => {
  render(<NetworkSettingsForm {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "TUN" }));
  expect(props.onApply).toHaveBeenCalledWith({ mode: "tun", localResolvers: [] });
  expect(screen.getByRole("button", { name: "Прокси" }).getAttribute("aria-current")).toBe("true");
  expect(screen.queryByRole("button", { name: "Проверить" })).toBeNull();
});
it("shows progress, blocks duplicate switches, and presents an application error", () => {
  const { rerender } = render(<NetworkSettingsForm {...props} pending pendingMode="tun" />);
  expect(screen.getByRole("status").textContent).toContain("Включаем TUN");
  expect(screen.getByRole("button", { name: "TUN" })).toBeDisabled();
  rerender(<NetworkSettingsForm {...props} error="Не удалось включить TUN" />);
  expect(screen.getByRole("alert").textContent).toContain("Не удалось включить TUN");
  expect(screen.getByRole("button", { name: "Прокси" }).getAttribute("aria-current")).toBe("true");
});
it("saves optional home DNS on blur and rejects a malformed address", () => {
  const apply = vi.fn();
  render(<NetworkSettingsForm {...props} onApply={apply} />);
  const dns = screen.getByRole("textbox", { name: "DNS домашней сети" });
  fireEvent.change(dns, { target: { value: "not-an-address" } });
  fireEvent.blur(dns);
  expect(apply).not.toHaveBeenCalled();
  fireEvent.change(dns, { target: { value: "192.168.1.1" } });
  fireEvent.blur(dns);
  expect(apply).toHaveBeenCalledWith({ mode: "proxy", localResolvers: ["192.168.1.1"] });
});
