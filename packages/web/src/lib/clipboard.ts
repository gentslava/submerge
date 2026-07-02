import { toast } from "sonner";

// Copy text to the clipboard with a success/error toast — shared by every copy button.
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Скопировано");
  } catch {
    toast.error("Не удалось скопировать");
  }
}
