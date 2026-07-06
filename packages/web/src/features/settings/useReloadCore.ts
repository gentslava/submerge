import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { warnIfNotApplied } from "@/lib/apply-toast";
import { useTRPC } from "@/lib/trpc";

// Wires the "Перезагрузить конфиг" control: regenerates + reloads the mihomo config
// (PUT /configs). Shared by the sidebar (desktop) and the "Ещё" screen (mobile) so
// both stay in sync.
export function useReloadCore() {
  const trpc = useTRPC();
  return useMutation(
    trpc.settings.reload.mutationOptions({
      onSuccess: (data) => {
        // Only claim success when the engine actually reloaded; otherwise the
        // shared warning explains the config lands on the next connection.
        if (data.applied) toast.success("Конфиг перезагружен");
        else warnIfNotApplied(data.applied);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
}
