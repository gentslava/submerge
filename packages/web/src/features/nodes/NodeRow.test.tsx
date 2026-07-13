import type { NodeItem } from "@submerge/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NodeRow } from "./NodeRow";

vi.mock("./SpeedTestContext", () => ({
  useSpeedTest: () => ({
    mbpsOf: () => null,
    testing: new Set<string>(),
    request: vi.fn(),
  }),
}));

const base = {
  isActive: false,
  onSelect: vi.fn(),
  onPing: vi.fn(),
  onToggleExcluded: vi.fn(),
};

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected a rendered element");
  return item;
}

describe("NodeRow", () => {
  it("renders the latency label and calls onSelect when Выбрать is clicked", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, history: [] };
    const onSelect = vi.fn();
    render(<NodeRow {...base} item={item} onSelect={onSelect} />);

    expect(screen.getAllByText("47 ms")).toHaveLength(2);

    const selectButtons = screen.getAllByRole("button", { name: "Выбрать" });
    expect(selectButtons).toHaveLength(2);
    fireEvent.click(first(selectButtons));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("derives the protocol sublabel from the node (type + transport/security)", () => {
    const item: NodeItem = {
      name: "NL-1",
      type: "vless",
      delay: 47,
      network: "tcp",
      security: "reality",
      history: [],
    };
    render(<NodeRow {...base} item={item} />);

    expect(screen.getAllByText("VLESS · TCP · Reality")).toHaveLength(2);
  });

  it("shows the timeout label for a non-positive delay", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 0, history: [] };
    render(<NodeRow {...base} item={item} />);

    expect(screen.getAllByText("timeout")).toHaveLength(2);
  });

  it("calls onPing when the per-row ping button is clicked", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, history: [] };
    const onPing = vi.fn();
    render(<NodeRow {...base} item={item} onPing={onPing} />);

    fireEvent.click(screen.getByRole("button", { name: "Пинговать NL-1" }));
    expect(onPing).toHaveBeenCalledTimes(1);
  });

  it("keeps secondary actions in the mobile context menu", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, history: [] };
    const onPing = vi.fn();
    render(<NodeRow {...base} item={item} onPing={onPing} />);

    fireEvent.click(screen.getByRole("button", { name: "Действия для NL-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Проверить пинг" }));

    expect(onPing).toHaveBeenCalledTimes(1);
  });

  it("keeps the speed test action on one line", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, history: [] };
    render(<NodeRow {...base} item={item} />);

    fireEvent.click(screen.getByRole("button", { name: "Действия для NL-1" }));

    expect(screen.getByRole("button", { name: "Замерить скорость" })).toHaveClass(
      "whitespace-nowrap",
    );
  });

  it("returns focus to the trigger after starting a speed test", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, history: [] };
    render(<NodeRow {...base} item={item} />);

    const trigger = screen.getByRole("button", { name: "Действия для NL-1" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Замерить скорость" }));

    expect(trigger).toHaveFocus();
  });

  it("uses ordinary buttons rather than an incomplete ARIA menu pattern", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, history: [] };
    render(<NodeRow {...base} item={item} />);

    fireEvent.click(screen.getByRole("button", { name: "Действия для NL-1" }));

    expect(screen.getByRole("button", { name: "Проверить пинг" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Проверить пинг" })).toBeNull();
  });

  it("shows the Активен action and no Выбрать button when active", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, history: [] };
    render(<NodeRow {...base} item={item} isActive={true} />);

    expect(screen.getAllByText("Активен")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Выбрать" })).toBeNull();
  });

  it("expands a collapsed group to show view-only members", () => {
    const item: NodeItem = {
      name: "G",
      type: "URLTest",
      delay: 40,
      history: [],
      members: [
        { name: "G #1", delay: 90, history: [], active: false },
        { name: "G #2", delay: 40, history: [], active: true },
      ],
    };
    render(<NodeRow {...base} item={item} />);

    // group row shows the active member's ping, a server-count sub-line (not
    // "URLTEST"), and can still be selected as a whole
    expect(screen.getAllByText("40 ms")).toHaveLength(2);
    expect(screen.getAllByText("2 сервера")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Выбрать" })).toHaveLength(2);

    // members hidden until expanded
    expect(screen.queryByText("G #2 · активен")).toBeNull();
    fireEvent.click(first(screen.getAllByRole("button", { name: "Показать серверы G" })));
    expect(screen.getAllByText("G #2 · активен")).toHaveLength(2);
    expect(screen.getAllByText("90 ms")).toHaveLength(2);
  });
});
