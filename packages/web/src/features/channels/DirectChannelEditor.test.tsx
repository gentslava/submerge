import type { DirectChannel } from "@submerge/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DirectChannelEditor } from "./DirectChannelEditor";

const directChannel: DirectChannel = {
  id: "direct",
  name: "Direct",
  target: "direct",
  priority: 0,
  enabled: true,
  isDefault: false,
  directPresets: { privateNetworks: true, localDomains: true },
  matcher: {
    presets: ["telegram"],
    domains: ["router.home.arpa"],
    keywords: ["intranet"],
    ruleProviders: [],
    geosite: ["private"],
    geoip: ["PRIVATE"],
    cidrs: ["192.168.50.0/24"],
  },
};

describe("DirectChannelEditor", () => {
  it("renders both system presets and every custom matcher editor", () => {
    render(<DirectChannelEditor channel={directChannel} onChange={vi.fn()} />);

    expect(screen.getByText("Системные исключения")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Частные сети" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Локальные домены" })).toBeInTheDocument();
    expect(screen.getByText("Пользовательские правила")).toBeInTheDocument();
    expect(screen.getByText("Предустановленные домены")).toBeInTheDocument();
    expect(screen.getByLabelText("Добавить домен")).toBeInTheDocument();
    expect(screen.getByLabelText("Добавить слово")).toBeInTheDocument();
    expect(screen.getByText("Списки правил")).toBeInTheDocument();
    expect(screen.getByLabelText("Добавить категорию GEOSITE")).toBeInTheDocument();
    expect(screen.getByLabelText("Добавить код GEOIP")).toBeInTheDocument();
    expect(screen.getByLabelText("Добавить CIDR")).toBeInTheDocument();
  });

  it("emits a Direct-only preset patch", () => {
    const onChange = vi.fn();
    render(<DirectChannelEditor channel={directChannel} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Частные сети" }));
    expect(onChange).toHaveBeenCalledWith({
      directPresets: { privateNetworks: false, localDomains: true },
    });
  });

  it("emits the complete matcher when a CIDR is added", () => {
    const onChange = vi.fn();
    render(<DirectChannelEditor channel={directChannel} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить CIDR");
    fireEvent.change(input, { target: { value: "fd12:3456::/48" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith({
      matcher: { ...directChannel.matcher, cidrs: ["192.168.50.0/24", "fd12:3456::/48"] },
    });
  });

  it("does not expose proxy-only name, pool, policy, active-node, or delete controls", () => {
    render(<DirectChannelEditor channel={directChannel} onChange={vi.fn()} />);
    expect(screen.queryByLabelText("Имя канала")).not.toBeInTheDocument();
    expect(screen.queryByText("Пул")).not.toBeInTheDocument();
    expect(screen.queryByText("Политика")).not.toBeInTheDocument();
    expect(screen.queryByText(/активный узел/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /удалить канал/i })).not.toBeInTheDocument();
  });
});
