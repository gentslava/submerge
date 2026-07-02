import { useEffect, useRef } from "react";
import { Button } from "./button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm(): void;
  onClose(): void;
}

// Styled replacement for window.confirm on destructive actions. Built on the
// native <dialog> element: showModal() gives the focus trap, Esc handling and
// inert background for free — no portal/trap machinery to maintain.
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Удалить",
  cancelLabel = "Отмена",
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click handler only closes on a backdrop click; Esc is handled natively by <dialog>
    <dialog
      ref={ref}
      // Fires on Esc and on el.close() — the single funnel back to the owner state.
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> itself (content is the inner div).
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto w-[360px] rounded-lg border border-border-subtle bg-surface p-0 text-text-primary shadow-lg backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-1.5 px-5 pt-5 pb-4">
        <span className="text-cardtitle">{title}</span>
        {description && <span className="text-sub text-text-secondary">{description}</span>}
      </div>
      <div className="flex justify-end gap-2.5 px-5 pb-5">
        <Button variant="secondary" size="sm" onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
