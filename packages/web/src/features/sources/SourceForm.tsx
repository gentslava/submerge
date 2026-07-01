import { zodResolver } from "@hookform/resolvers/zod";
import { addSourceInput } from "@submerge/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Sparkles } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useTRPC } from "@/lib/trpc";
import { detectKindHint, KIND_LABEL } from "./detectKind";

// Use z.input to get the pre-default type: hwid?: boolean | undefined
type FormValues = z.input<typeof addSourceInput>;

export function SourceForm() {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const addMutation = useMutation(
    trpc.sources.add.mutationOptions({
      onSuccess: () => {
        reset();
        void qc.invalidateQueries({ queryKey: trpc.sources.list.queryKey() });
        toast.success("Источник добавлен");
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const { register, handleSubmit, watch, reset, control } = useForm<FormValues>({
    resolver: zodResolver(addSourceInput),
    defaultValues: { value: "", hwid: false },
  });

  const value = watch("value");
  const typed = (value ?? "").trim() !== "";
  const kindHint = detectKindHint(value ?? "");

  function onSubmit(data: FormValues) {
    // After zodResolver transforms, hwid defaults to false if undefined
    addMutation.mutate({ value: data.value, hwid: data.hwid ?? false });
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
      <div className="px-4 py-3.5">
        <span className="text-caption text-text-tertiary">ДОБАВИТЬ ИСТОЧНИК</span>
      </div>
      <div className="h-px w-full bg-border-subtle" />

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          {/* No inline validation: an empty value just disables Добавить (below); the
              placeholder is the hint. Server-side failures surface via a toast. */}
          <Textarea
            id="source-value"
            {...register("value")}
            placeholder={"vless://…   ·   happ://…   ·   https://…/sub/…"}
            aria-label="Ссылка источника"
            className="h-[120px] resize-none p-3.5"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sub text-text-secondary">Тип:</span>
            <span className="inline-flex items-center gap-[5px] rounded-full bg-hover px-[9px] py-[3px] text-meta text-text-tertiary">
              {typed ? (
                KIND_LABEL[kindHint]
              ) : (
                <>
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                  определится автоматически
                </>
              )}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <Controller
              name="hwid"
              control={control}
              render={({ field }) => (
                <Switch
                  id="hwid-switch"
                  checked={field.value ?? false}
                  onCheckedChange={field.onChange}
                  aria-label="Передавать HWID"
                />
              )}
            />
            <label htmlFor="hwid-switch" className="flex cursor-pointer flex-col gap-[3px]">
              <span className="text-sub font-medium text-text-primary">Передавать HWID</span>
              <span className="max-w-[320px] text-[11px] text-text-tertiary">
                Привязка к устройству — сервер выдаёт узлы только для текущего HWID
              </span>
            </label>
          </div>
        </div>

        <div className="flex justify-end">
          {/* The button sets disabled:pointer-events-none, so hover passes to this
              span — its title explains why Добавить is inactive while empty. */}
          <span title={typed ? undefined : "Вставьте ссылку источника"} className="inline-flex">
            <Button type="submit" disabled={!typed || addMutation.isPending}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {addMutation.isPending ? "Добавляю…" : "Добавить"}
            </Button>
          </span>
        </div>
      </form>
    </section>
  );
}
