import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

// jsdom has no <dialog> modal API — emulate just enough for the component.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});

function setup(open = true) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmDialog
      open={open}
      title="Удалить источник?"
      description="Узлы пропадут из списка."
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
  return { onConfirm, onClose };
}

describe("ConfirmDialog", () => {
  it("renders title, description and both actions when open", () => {
    setup();
    expect(screen.getByText("Удалить источник?")).toBeInTheDocument();
    expect(screen.getByText("Узлы пропадут из списка.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Удалить" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeInTheDocument();
  });

  it("confirm click calls onConfirm and then closes", async () => {
    const { onConfirm, onClose } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("cancel click closes without confirming", async () => {
    const { onConfirm, onClose } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
