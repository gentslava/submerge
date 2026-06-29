import type { NodeItem } from "@submerge/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NodeRow } from "./NodeRow";

describe("NodeRow", () => {
  it("renders latency label and calls onSelect when Выбрать is clicked", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47 };
    const onSelect = vi.fn();
    render(<NodeRow item={item} isActive={false} onSelect={onSelect} />);

    expect(screen.getByText("47 ms")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Выбрать" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("shows timeout label for a non-positive delay", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 0 };
    render(<NodeRow item={item} isActive={false} onSelect={vi.fn()} />);

    expect(screen.getByText("timeout")).toBeInTheDocument();
  });

  it("shows the active badge and no Выбрать button when active", () => {
    const item: NodeItem = { name: "NL-1", type: "vless", delay: 47 };
    render(<NodeRow item={item} isActive={true} onSelect={vi.fn()} />);

    expect(screen.getByText("Активен")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Выбрать" })).toBeNull();
  });
});
