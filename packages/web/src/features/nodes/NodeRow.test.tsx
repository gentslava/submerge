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
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, history: [] };
    const onSelect = vi.fn();
    render(<NodeRow {...base} item={item} onSelect={onSelect} />);

    expect(screen.getByText("47 ms")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Выбрать" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("derives the protocol sublabel from the node (type + UDP)", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, udp: true, history: [] };
    render(<NodeRow {...base} item={item} />);

    expect(screen.getByText("VLESS · UDP")).toBeInTheDocument();
  });

  it("shows the timeout label for a non-positive delay", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 0, history: [] };
    render(<NodeRow {...base} item={item} />);

    expect(screen.getByText("timeout")).toBeInTheDocument();
  });

  it("calls onPing when the per-row ping button is clicked", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, history: [] };
    const onPing = vi.fn();
    render(<NodeRow {...base} item={item} onPing={onPing} />);

    fireEvent.click(screen.getByRole("button", { name: "Пинговать NL-1" }));
    expect(onPing).toHaveBeenCalledTimes(1);
  });

  it("shows the Активен action and no Выбрать button when active", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47, history: [] };
    render(<NodeRow {...base} item={item} isActive={true} />);

    expect(screen.getByText("Активен")).toBeInTheDocument();
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

    // group row shows the active member's ping and can still be selected as a whole
    expect(screen.getByText("40 ms")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выбрать" })).toBeInTheDocument();

    // members hidden until expanded
    expect(screen.queryByText("G #2 · активен")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Показать серверы G" }));
    expect(screen.getByText("G #2 · активен")).toBeInTheDocument();
    expect(screen.getByText("90 ms")).toBeInTheDocument();
  });
});
