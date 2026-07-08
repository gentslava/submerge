import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeywordTags } from "./KeywordTags";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(() => vi.clearAllMocks());

describe("KeywordTags", () => {
  it("renders existing keywords as removable chips", () => {
    render(<KeywordTags value={["doubleclick", "adservice"]} onChange={vi.fn()} />);
    expect(screen.getByText("doubleclick")).toBeInTheDocument();
    expect(screen.getByText("adservice")).toBeInTheDocument();
  });

  it("adds a keyword on Enter and clears the field", () => {
    const onChange = vi.fn();
    render(<KeywordTags value={["doubleclick"]} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить слово");
    fireEvent.change(input, { target: { value: "analytics" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["doubleclick", "analytics"]);
  });

  it("rejects a keyword with whitespace on Enter, toasts, and keeps the draft", () => {
    const onChange = vi.fn();
    render(<KeywordTags value={[]} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить слово");
    fireEvent.change(input, { target: { value: "bad kw" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Некорректное слово");
    expect(input).toHaveValue("bad kw");
  });

  it("removes a keyword when its × is clicked", () => {
    const onChange = vi.fn();
    render(<KeywordTags value={["doubleclick", "adservice"]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Удалить слово «doubleclick»"));
    expect(onChange).toHaveBeenCalledWith(["adservice"]);
  });
});
