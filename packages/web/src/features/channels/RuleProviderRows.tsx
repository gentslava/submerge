import { type RuleProviderRef, ruleProviderFormat, ruleProviderRefSchema } from "@submerge/shared";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Behavior = RuleProviderRef["behavior"];

// A local, editable row. `id` is a client-only key so removing/adding rows doesn't
// scramble React state across the controlled inputs. A freshly-added row has an
// empty URL (not yet committable) — see validRefs().
interface DraftRow {
  id: string;
  url: string;
  behavior: Behavior;
}

// The rows that pass the shared schema (valid http(s) URL; an .mrs URL must not be
// classical), deduped by (url, behavior). An empty/invalid draft row is kept in the
// editor but not committed to the channel until it validates.
export function validRefs(rows: { url: string; behavior: Behavior }[]): RuleProviderRef[] {
  const out: RuleProviderRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const parsed = ruleProviderRefSchema.safeParse({ url: row.url, behavior: row.behavior });
    if (!parsed.success) continue;
    const key = `${parsed.data.url}|${parsed.data.behavior}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
  }
  return out;
}

// mihomo forbids mrs + classical; if the URL is an .mrs list, move a classical row
// to domain so it stays valid (matches the schema guard).
function coerce(row: DraftRow): DraftRow {
  if (ruleProviderFormat(row.url) === "mrs" && row.behavior === "classical") {
    return { ...row, behavior: "domain" };
  }
  return row;
}

interface RuleProviderRowsProps {
  value: RuleProviderRef[];
  onChange: (refs: RuleProviderRef[]) => void;
}

/**
 * Repeatable external-rule-list rows — measured from the mockup's «Списки правил»:
 * each row is a URL field + a «Тип» (behavior) select + a delete button; a
 * «＋ Добавить список» button appends a row. The mihomo `format` is derived from the
 * URL extension (no format control). On narrow widths the row stacks (URL on top,
 * controls below).
 *
 * Commit model mirrors the tag inputs: the URL commits on blur (not per keystroke —
 * each commit regenerates + reloads the mihomo config), while the behavior select and
 * delete commit immediately. A non-empty URL that doesn't validate is flagged
 * (aria-invalid) and left out of the committed set rather than silently dropped.
 */
export function RuleProviderRows({ value, onChange }: RuleProviderRowsProps) {
  const [rows, setRows] = useState<DraftRow[]>(() =>
    value.map((r) => ({ id: crypto.randomUUID(), url: r.url, behavior: r.behavior })),
  );

  // `commit` persists the valid subset to the channel; `local` only updates the
  // editing state (used while typing a URL — committed on blur).
  function local(next: DraftRow[]) {
    setRows(next);
  }
  function commit(next: DraftRow[]) {
    setRows(next);
    onChange(validRefs(next));
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => {
        const trimmed = row.url.trim();
        const invalid =
          trimmed.length > 0 &&
          !ruleProviderRefSchema.safeParse({ url: trimmed, behavior: row.behavior }).success;
        const mrs = ruleProviderFormat(row.url) === "mrs";
        return (
          <div key={row.id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={row.url}
              onChange={(e) =>
                local(
                  rows.map((r) => (r.id === row.id ? coerce({ ...r, url: e.target.value }) : r)),
                )
              }
              onBlur={() => commit(rows)}
              placeholder="https://…/list.yaml"
              aria-label={`URL списка правил ${index + 1}`}
              aria-invalid={invalid}
              className={cn(
                "font-mono text-sub sm:min-w-0 sm:flex-1",
                invalid && "border-timeout focus-visible:ring-timeout",
              )}
            />
            <div className="flex items-center gap-2 sm:shrink-0">
              <Select
                value={row.behavior}
                onChange={(e) =>
                  commit(
                    rows.map((r) =>
                      r.id === row.id ? coerce({ ...r, behavior: e.target.value as Behavior }) : r,
                    ),
                  )
                }
                aria-label={`Тип списка правил ${index + 1}`}
                className="w-[150px]"
              >
                {/* mrs supports only domain/ipcidr — disable classical for an .mrs URL. */}
                <option value="classical" disabled={mrs}>
                  classical
                </option>
                <option value="domain">domain</option>
                <option value="ipcidr">ipcidr</option>
              </Select>
              <button
                type="button"
                onClick={() => commit(rows.filter((r) => r.id !== row.id))}
                aria-label={`Удалить список ${index + 1}`}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() =>
          local([...rows, { id: crypto.randomUUID(), url: "", behavior: "classical" }])
        }
        className={cn(
          "flex items-center justify-center gap-2 rounded-md border border-border-default px-3 py-2 text-sub font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary",
          rows.length === 0 ? "w-full" : "self-start",
        )}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Добавить список
      </button>
    </div>
  );
}
