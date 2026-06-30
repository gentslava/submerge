import type { NodeItem } from "@submerge/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NodeRow } from "./NodeRow";

const base = {
  isActive: false,
  onSelect: vi.fn(),
  onPing: vi.fn(),
};

describe("NodeRow", () => {
  it("renders the latency label and calls onSelect when Выбрать is clicked", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47 };
    const onSelect = vi.fn();
    render(<NodeRow {...base} item={item} onSelect={onSelect} />);

    expect(screen.getByText("47 ms")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Выбрать" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("derives the protocol sublabel from the node (type + UDP)", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, udp: true };
    render(<NodeRow {...base} item={item} />);

    expect(screen.getByText("VLESS · UDP")).toBeInTheDocument();
  });

  it("shows the timeout label for a non-positive delay", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 0 };
    render(<NodeRow {...base} item={item} />);

    expect(screen.getByText("timeout")).toBeInTheDocument();
  });

  it("calls onPing when the per-row ping button is clicked", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47 };
    const onPing = vi.fn();
    render(<NodeRow {...base} item={item} onPing={onPing} />);

    fireEvent.click(screen.getByRole("button", { name: "Пинговать NL-1" }));
    expect(onPing).toHaveBeenCalledTimes(1);
  });

  it("shows the Активен action and no Выбрать button when active", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47 };
    render(<NodeRow {...base} item={item} isActive={true} />);

    expect(screen.getByText("Активен")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Выбрать" })).toBeNull();
  });
});
