import { zodResolver } from "@hookform/resolvers/zod";
import { addSourceInput } from "@submerge/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Sparkles, Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { warnIfNotApplied } from "@/lib/apply-toast";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { detectKindHint, KIND_LABEL } from "./detectKind";

// Use z.input to get the pre-default type: hwid?: boolean | undefined
type FormValues = z.input<typeof addSourceInput>;

const MAX_CONF_BYTES = 512_000; // a WireGuard/subscription file is tiny; guard against a wrong pick

export function SourceForm() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const fileInputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const addMutation = useMutation(
    trpc.sources.add.mutationOptions({
      onSuccess: (data) => {
        reset();
        void qc.invalidateQueries({ queryKey: trpc.sources.list.queryKey() });
        toast.success("Источник добавлен");
        warnIfNotApplied(data.applied);
        if (data.skipped?.length)
          toast.warning(
            `Пропущено ${data.skipped.length}: неподдерживаемые протоколы (${data.skipped.join(", ")})`,
          );
      },
      onError: (e) => {
        toast.error(e.message);
        // CONFLICT = the source already exists: nothing to fix and resubmit, so
        // clear the field. Other errors (parse/network) keep the text for a retry.
        if (e.data?.code === "CONFLICT") reset();
      },
    }),
  );

  const { register, handleSubmit, watch, reset, control, setValue } = useForm<FormValues>({
    resolver: zodResolver(addSourceInput),
    defaultValues: { value: "", hwid: false },
  });

  const value = watch("value");
  const typed = (value ?? "").trim() !== "";
  const kindHint = detectKindHint(value ?? "");

  // Read a dropped/picked config file into the text field — the parser keys on the
  // content (e.g. [Interface] for a .conf), so ingestion is identical to a paste.
  async function loadFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_CONF_BYTES) {
      toast.error("Файл слишком большой для конфига источника");
      return;
    }
    const text = await file.text();
    setValue("value", text, { shouldValidate: true, shouldDirty: true });
  }

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
        <div className="flex flex-col gap-1.5">
          {/* No inline validation: an empty value just disables Добавить (below); the
              placeholder is the hint. Server-side failures surface via a toast. The
              wrapper is a drop zone — dropping a .conf/.txt fills the field. */}
          <div className={cn("rounded-md", dragging && "ring-2 ring-accent-border")}>
            <Textarea
              id="source-value"
              {...register("value")}
              placeholder={"vless://…   ·   happ://…   ·   https://…/sub/…   ·   AmneziaWG .conf"}
              aria-label="Ссылка источника"
              className="h-[120px] resize-none p-3.5"
              onDragOver={(e) => {
                e.preventDefault();
                if (!dragging) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void loadFile(e.dataTransfer.files?.[0]);
              }}
            />
          </div>
          {/* File affordance — a .conf is easier to attach than to copy out of a file. */}
          <div className="flex items-center gap-2 text-fine text-text-tertiary">
            <input
              ref={fileRef}
              id={fileInputId}
              type="file"
              accept=".conf,.txt,text/plain"
              className="sr-only"
              onChange={(e) => {
                void loadFile(e.target.files?.[0]);
                e.target.value = ""; // allow re-picking the same file
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              Выбрать файл
            </button>
            <span>или перетащите .conf сюда</span>
          </div>
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
              <span className="max-w-[320px] text-fine text-text-tertiary">
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
