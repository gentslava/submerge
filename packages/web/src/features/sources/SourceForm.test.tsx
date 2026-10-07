import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithClient } from "@/test/utils";
import { KIND_LABEL } from "./detectKind";
import { SourceForm } from "./SourceForm";

const addSource = vi.hoisted(() => vi.fn(async () => ({ applied: true })));

vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    sources: {
      add: { mutationOptions: (options: object) => ({ ...options, mutationFn: addSource }) },
      list: { queryKey: () => ["sources", "list"] },
    },
  }),
}));

describe("SourceForm", () => {
  it("recognizes a JSON config, hides HWID, and submits it with HWID off", async () => {
    renderWithClient(<SourceForm />);
    fireEvent.click(screen.getByRole("switch"));
    const value = JSON.stringify({ outbounds: [{ protocol: "vless" }] });
    fireEvent.change(screen.getByLabelText("Ссылка источника"), { target: { value } });
    expect(await screen.findByText("один узел · JSON / YAML")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    await waitFor(() =>
      expect(addSource).toHaveBeenCalledWith({ value, hwid: false }, expect.anything()),
    );
  });

  it("loads a JSON file into the same automatically detected text field", async () => {
    renderWithClient(<SourceForm />);
    const value = '{"outbounds": []}';
    const file = new File([value], "node.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => value });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toHaveAttribute("accept", expect.stringContaining(".json"));
    if (!input) throw new Error("Expected file input");
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText("Ссылка источника")).toHaveValue(value));
    expect(screen.getByText("один узел · JSON / YAML")).toBeInTheDocument();
  });
  it("shows the type badge when a vless value is entered", async () => {
    renderWithClient(<SourceForm />);

    const textarea = screen.getByLabelText("Ссылка источника");
    fireEvent.change(textarea, { target: { value: "vless://abc" } });

    expect(await screen.findByText(KIND_LABEL.vless)).toBeInTheDocument();
  });

  it("disables the add button until a value is entered", () => {
    renderWithClient(<SourceForm />);

    const btn = screen.getByRole("button", { name: /Добавить/ });
    expect(btn).toBeDisabled();
    // hover hint explaining why it's inactive (on the wrapper — the button has
    // pointer-events:none while disabled)
    expect(btn.parentElement).toHaveAttribute("title", "Вставьте ссылку или конфиг источника");

    fireEvent.change(screen.getByLabelText("Ссылка источника"), {
      target: { value: "vless://abc" },
    });
    expect(btn).toBeEnabled();
    expect(btn.parentElement).not.toHaveAttribute("title");
  });

  it("toggles the HWID switch aria-checked", () => {
    renderWithClient(<SourceForm />);

    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");

    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
  });
});
