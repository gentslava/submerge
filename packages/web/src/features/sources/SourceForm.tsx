import { zodResolver } from "@hookform/resolvers/zod";
import { addSourceInput } from "@submerge/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

  const {
    register,
    handleSubmit,
    watch,
    reset,
    control,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(addSourceInput),
    defaultValues: { value: "", hwid: false },
  });

  const value = watch("value");
  const kindHint = detectKindHint(value ?? "");

  function onSubmit(data: FormValues) {
    // After zodResolver transforms, hwid defaults to false if undefined
    addMutation.mutate({ value: data.value, hwid: data.hwid ?? false });
  }

  return (
    <Card className="p-4">
      <h2 className="mb-3 text-base font-semibold text-text-primary">Добавить источник</h2>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Textarea
            {...register("value")}
            placeholder={"vless://…   ·   happ://…   ·   https://…/sub/…"}
            aria-label="Ссылка источника"
          />
          {errors.value && <p className="text-xs text-timeout">{errors.value.message}</p>}
          {(value ?? "").trim() && (
            <div className="flex items-center gap-1.5">
              <Badge variant="neutral">{KIND_LABEL[kindHint]}</Badge>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1">
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
            <label htmlFor="hwid-switch" className="cursor-pointer text-sm text-text-primary">
              Передавать HWID (привязка к устройству)
            </label>
          </div>
          <p className="ml-12 text-xs text-text-tertiary">
            Включайте только для провайдеров с привязкой к устройству.
          </p>
        </div>

        <Button type="submit" disabled={addMutation.isPending} className="self-start">
          {addMutation.isPending ? "Добавляю…" : "Добавить"}
        </Button>
      </form>
    </Card>
  );
}
