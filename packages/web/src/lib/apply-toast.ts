import { toast } from "sonner";

// Mutations that regenerate the mihomo config return `applied: false` when the
// change was SAVED but the engine reload failed (engine down/unreachable). That
// is not an error — surface it as a warning so the user knows the config lands
// on the engine's next successful reload.
export function warnIfNotApplied(applied: boolean): void {
  if (!applied) {
    toast.warning("Сохранено, но движок недоступен — применится при следующем подключении");
  }
}
