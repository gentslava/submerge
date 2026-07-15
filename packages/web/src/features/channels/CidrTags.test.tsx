import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CidrTags } from "./CidrTags";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(() => vi.clearAllMocks());

describe("CidrTags", () => {
  it("trims, validates, and appends IPv4 and IPv6 CIDRs", () => {
    const onChange = vi.fn();
    const { rerender } = render(<CidrTags value={[]} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить CIDR");

    fireEvent.change(input, { target: { value: "  192.168.50.0/24  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(["192.168.50.0/24"]);

    rerender(<CidrTags value={["192.168.50.0/24"]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Добавить CIDR"), {
      target: { value: "fd12:3456::/48" },
    });
    fireEvent.keyDown(screen.getByLabelText("Добавить CIDR"), { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(["192.168.50.0/24", "fd12:3456::/48"]);
  });

  it("deduplicates an existing CIDR", () => {
    const onChange = vi.fn();
    render(<CidrTags value={["10.0.0.0/8"]} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить CIDR");
    fireEvent.change(input, { target: { value: "10.0.0.0/8" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects a bare address through the shared CIDR validator", () => {
    const onChange = vi.fn();
    render(<CidrTags value={[]} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить CIDR");
    fireEvent.change(input, { target: { value: "192.168.50.1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Некорректная подсеть CIDR");
  });

  it("removes only the selected CIDR", () => {
    const onChange = vi.fn();
    render(<CidrTags value={["10.0.0.0/8", "fd12:3456::/48"]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Удалить CIDR «10.0.0.0/8»"));
    expect(onChange).toHaveBeenCalledWith(["fd12:3456::/48"]);
  });
});
