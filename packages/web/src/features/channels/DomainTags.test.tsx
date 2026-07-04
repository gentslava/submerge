import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDomain, DomainTags, removeDomain } from "./DomainTags";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(() => vi.clearAllMocks());

describe("addDomain", () => {
  it("appends a trimmed domain", () => {
    expect(addDomain(["t.me"], "  discord.gg  ")).toEqual(["t.me", "discord.gg"]);
  });

  it("ignores an empty/whitespace-only candidate", () => {
    expect(addDomain(["t.me"], "   ")).toEqual(["t.me"]);
  });

  it("dedupes an already-present domain", () => {
    expect(addDomain(["t.me", "discord.gg"], "t.me")).toEqual(["t.me", "discord.gg"]);
  });
});

describe("removeDomain", () => {
  it("removes only the targeted domain", () => {
    expect(removeDomain(["t.me", "discord.gg"], "t.me")).toEqual(["discord.gg"]);
  });

  it("is a no-op when the domain isn't present", () => {
    expect(removeDomain(["t.me"], "discord.gg")).toEqual(["t.me"]);
  });
});

describe("DomainTags", () => {
  it("renders existing domains as removable chips", () => {
    render(<DomainTags value={["t.me", "discord.gg"]} onChange={vi.fn()} />);
    expect(screen.getByText("t.me")).toBeInTheDocument();
    expect(screen.getByText("discord.gg")).toBeInTheDocument();
  });

  it("adds a domain on Enter and clears the field", () => {
    const onChange = vi.fn();
    render(<DomainTags value={["t.me"]} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить домен");
    fireEvent.change(input, { target: { value: "discord.gg" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["t.me", "discord.gg"]);
  });

  it("adds a domain on blur", () => {
    const onChange = vi.fn();
    render(<DomainTags value={[]} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить домен");
    fireEvent.change(input, { target: { value: "telegram.org" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(["telegram.org"]);
  });

  it("ignores an empty commit (blur with no typed text)", () => {
    const onChange = vi.fn();
    render(<DomainTags value={["t.me"]} onChange={onChange} />);
    fireEvent.blur(screen.getByLabelText("Добавить домен"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects an invalid domain on Enter, toasts, and keeps the draft for editing", () => {
    const onChange = vi.fn();
    render(<DomainTags value={[]} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить домен");
    fireEvent.change(input, { target: { value: "bad domain" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Некорректный домен");
    expect(input).toHaveValue("bad domain");
  });

  it("silently clears an invalid domain on blur without toasting", () => {
    const onChange = vi.fn();
    render(<DomainTags value={[]} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить домен");
    fireEvent.change(input, { target: { value: "bad domain" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });

  it("removes a domain when its × is clicked", () => {
    const onChange = vi.fn();
    render(<DomainTags value={["t.me", "discord.gg"]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Удалить домен «t.me»"));
    expect(onChange).toHaveBeenCalledWith(["discord.gg"]);
  });
});
