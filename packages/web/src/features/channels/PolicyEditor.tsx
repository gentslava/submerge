import type { ChannelPolicy } from "@submerge/shared";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatInterval } from "@/lib/duration";

// Check interval: from the most frequent (unstable links — fastest switching) to the
// longest (stable — don't keep pinging configs). Large values read as minutes.
const CHECK_PRESETS = [5, 10, 30, 60, 300, 600];

// Render interval <option>s (с / мин), keeping the current value present even off-preset.
function secondsOptions(presets: number[], current: string) {
  const cur = Number(current);
  const values =
    Number.isFinite(cur) && cur > 0 && !presets.includes(cur)
      ? [...presets, cur].sort((a, b) => a - b)
      : presets;
  return values.map((v) => (
    <option key={v} value={String(v)}>
      {formatInterval(v)}
    </option>
  ));
}

/**
 * Controlled editor for a channel's auto-select policy — the Segmented kind switcher
 * («По задержке / Стабильный IP / Приоритетный узел») plus the per-kind knobs. Pure
 * presentation + local "next policy" computation: it never calls tRPC and knows
 * nothing about persistence or defaults — the parent owns `onChange` (typically a
 * `channels.setPolicy` mutation) and supplies `nodeNames` for the manual pin dropdown.
 *
 * Shared by the Settings screen and the Routing screen so both edit exactly one
 * implementation of this UI.
 */
export function PolicyEditor({
  policy,
  onChange,
  nodeNames,
}: {
  policy: ChannelPolicy;
  onChange: (next: ChannelPolicy) => void;
  nodeNames: string[];
}) {
  function updateSpeed(patch: Partial<Extract<ChannelPolicy, { kind: "speed" }>>) {
    if (policy.kind !== "speed") return;
    onChange({ ...policy, ...patch });
  }

  function updateSticky(patch: Partial<Extract<ChannelPolicy, { kind: "sticky" }>>) {
    if (policy.kind !== "sticky") return;
    onChange({ ...policy, ...patch });
  }

  function updateManual(patch: Partial<Extract<ChannelPolicy, { kind: "manual" }>>) {
    if (policy.kind !== "manual") return;
    onChange({ ...policy, ...patch });
  }

  // Switch the policy kind, carrying over shared fields where they exist and seeding
  // the rest with sane defaults. `manual` needs a concrete node, so it seeds from the
  // first available one (the caller-supplied `nodeNames`, without a notion of "the
  // currently active node" — that context lives with the parent's node data, not here).
  function switchPolicy(kind: ChannelPolicy["kind"]) {
    if (policy.kind === kind) return;
    if (kind === "manual") {
      const pinnedNode = nodeNames[0];
      if (!pinnedNode) {
        toast.error("Нет доступных узлов для закрепления");
        return;
      }
      onChange({ kind: "manual", pinnedNode, onFailure: "fallback" });
      return;
    }
    const testUrl = "testUrl" in policy ? policy.testUrl : "https://www.gstatic.com/generate_204";
    const intervalSec = "intervalSec" in policy ? policy.intervalSec : 60;
    const next: ChannelPolicy =
      kind === "speed"
        ? { kind: "speed", testUrl, intervalSec, toleranceMs: 50, reevaluateWhileHealthy: true }
        : {
            kind: "sticky",
            testUrl,
            intervalSec,
            failureThreshold: 3,
            maxHoldHours: null,
            initialCriterion: "fastest",
          };
    onChange(next);
  }

  return (
    <>
      <Row
        label="Политика"
        sub="По задержке — гонка; стабильный IP — держит узел; приоритетный — ваш узел"
      >
        <Segmented
          aria-label="Политика выбора"
          value={policy.kind}
          onChange={(v) => switchPolicy(v as ChannelPolicy["kind"])}
          options={[
            { value: "speed", label: "По задержке" },
            { value: "sticky", label: "Стабильный IP" },
            { value: "manual", label: "Приоритетный узел" },
          ]}
        />
      </Row>
      {policy.kind === "sticky" ? (
        <>
          <Row label="Проверочный URL" sub="Куда mihomo шлёт проверочный запрос">
            <Input
              key={policy.testUrl}
              type="url"
              aria-label="Проверочный URL"
              defaultValue={policy.testUrl}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v.length > 0) updateSticky({ testUrl: v });
              }}
              className="w-full font-mono text-sub md:w-[360px]"
            />
          </Row>
          <Row label="Интервал проверки, с" sub="Как часто переизмерять задержку">
            <Select
              aria-label="Интервал проверки"
              value={String(policy.intervalSec)}
              onChange={(e) => updateSticky({ intervalSec: Number(e.target.value) })}
            >
              {secondsOptions(CHECK_PRESETS, String(policy.intervalSec))}
            </Select>
          </Row>
          <Row label="Порог сбоев" sub="Подряд идущих неудач перед переключением узла">
            <Input
              key={policy.failureThreshold}
              type="number"
              aria-label="Порог сбоев"
              min={1}
              step={1}
              defaultValue={policy.failureThreshold}
              onBlur={(e) => {
                const trimmed = e.target.value.trim();
                if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) return;
                updateSticky({ failureThreshold: Number(trimmed) });
              }}
              className="w-[90px] text-center font-mono"
            />
          </Row>
          <Row label="Держать не дольше, ч" sub="Пусто — держать узел неограниченно долго">
            <Input
              key={policy.maxHoldHours ?? "unlimited"}
              type="number"
              aria-label="Держать не дольше (ч)"
              min={1}
              step={1}
              placeholder="∞"
              defaultValue={policy.maxHoldHours ?? ""}
              onBlur={(e) => {
                const trimmed = e.target.value.trim();
                if (trimmed === "") {
                  updateSticky({ maxHoldHours: null });
                  return;
                }
                if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) return;
                updateSticky({ maxHoldHours: Number(trimmed) });
              }}
              className="w-[90px] text-center font-mono"
            />
          </Row>
          <Row
            label="Критерий выбора"
            sub="По скорости — наименьший пинг; по стабильности — узел с меньшими потерями пакетов"
          >
            <Segmented
              aria-label="Критерий выбора"
              value={policy.initialCriterion}
              onChange={(v) => updateSticky({ initialCriterion: v as "fastest" | "lowest-loss" })}
              options={[
                { value: "fastest", label: "По скорости" },
                { value: "lowest-loss", label: "По стабильности" },
              ]}
            />
          </Row>
        </>
      ) : policy.kind === "manual" ? (
        <>
          <Row label="Приоритетный узел" sub="Через него идёт трафик большую часть времени">
            <Select
              aria-label="Приоритетный узел"
              value={policy.pinnedNode}
              onChange={(e) => updateManual({ pinnedNode: e.target.value })}
              className="w-full md:w-[280px]"
            >
              {/* Keep the current pin present even if it's momentarily absent from the live list. */}
              {(nodeNames.includes(policy.pinnedNode)
                ? nodeNames
                : [policy.pinnedNode, ...nodeNames]
              ).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Row>
          <Row
            label="При отказе узла"
            sub="Если приоритетный узел недоступен — уйти на запасной или держать его"
          >
            <Segmented
              aria-label="При отказе узла"
              value={policy.onFailure}
              onChange={(v) => updateManual({ onFailure: v as "fallback" | "hold" })}
              options={[
                { value: "fallback", label: "Запасной узел" },
                { value: "hold", label: "Держать" },
              ]}
            />
          </Row>
        </>
      ) : (
        <>
          <Row label="Тест-URL" sub="Куда mihomo шлёт проверочный запрос">
            <Input
              key={policy.testUrl}
              type="url"
              aria-label="Тест-URL"
              defaultValue={policy.testUrl}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v.length > 0) updateSpeed({ testUrl: v });
              }}
              className="w-full font-mono text-sub md:w-[360px]"
            />
          </Row>
          <Row label="Интервал проверки" sub="Как часто переизмерять задержку">
            <Select
              aria-label="Интервал проверки"
              value={String(policy.intervalSec)}
              onChange={(e) => updateSpeed({ intervalSec: Number(e.target.value) })}
            >
              {secondsOptions(CHECK_PRESETS, String(policy.intervalSec))}
            </Select>
          </Row>
          <Row label="Допуск, мс" sub="Не переключаться при разнице меньше допуска">
            <Input
              key={policy.toleranceMs}
              type="number"
              aria-label="Допуск (мс)"
              min={0}
              step={1}
              defaultValue={policy.toleranceMs}
              onBlur={(e) => {
                const trimmed = e.target.value.trim();
                if (!/^\d+$/.test(trimmed)) return;
                updateSpeed({ toleranceMs: Number(trimmed) });
              }}
              className="w-[90px] text-center font-mono"
            />
          </Row>
          <Row
            label="Переоценивать, пока узел жив"
            sub="Переизмерять задержку каждый интервал, даже если активный узел здоров"
          >
            <Switch
              checked={policy.reevaluateWhileHealthy}
              onCheckedChange={(v) => updateSpeed({ reevaluateWhileHealthy: v })}
              aria-label="Переоценивать, пока узел жив"
            />
          </Row>
        </>
      )}
    </>
  );
}

// Identical copy of SettingsScreen's local `Row` (label + sub + control row). Kept as
// an internal, unexported duplicate rather than importing from features/settings to
// avoid a cross-feature/circular dependency (Settings imports PolicyEditor; the
// upcoming Routing screen will too) — it's a trivial, stable layout primitive.
function Row({ label, sub, children }: { label: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border-subtle px-[18px] py-4 last:border-0 md:flex-row md:items-center md:justify-between md:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <span className="text-xs text-text-tertiary">{sub}</span>
      </div>
      <div className="flex w-full items-center gap-2.5 md:w-auto md:shrink-0">{children}</div>
    </div>
  );
}
