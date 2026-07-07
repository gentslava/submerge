# «Оптимальный» policy — historical-winner node selection — design

- **Date:** 2026-07-07
- **Status:** Draft (design agreed; not yet implemented)
- **Related:** [2026-07-01 channel routing](2026-07-01-channel-routing-design.md), [2026-07-03 background prober](2026-07-03-background-prober-design.md), ADR-0004 (anti-overengineering)
- **Extends:** the channel `policy` discriminated union (`speed | sticky | manual`) with a fourth kind, `optimal`.

## 1. Problem

The `speed` policy is mihomo-owned: the channel group is a `url-test` that picks the
instantaneously fastest node with a `tolerance` hysteresis, and our controller only
*logs* the moves (`tickSpeed` is passive). On a fleet of near-equal nodes this flaps —
the exit node hops every interval chasing sub-tolerance latency noise (observed in the
decision log: `ch-ch2::…Бельгия ↔ …Самый быстрый` every 1–2 min at 27–67 ms deltas).

The two active policies don't cover the wanted middle ground:

- `sticky` holds the first pick **until it fails a health-check** (liveness-driven). It
  ignores whether the pinned node stays fast — a node that degrades to consistently slow
  (but alive) is never left. Optimizes *IP stability*, not *speed over time*.
- `speed` optimizes the *moment*, so it flaps.

**Missing:** "pick the node that is consistently fast **and** alive over a recent window,
and only move when another node is durably better" — a statistics-driven choice that
smooths out momentary spikes without freezing on a stale pin.

## 2. Goals

1. A new policy **`optimal`** ("Оптимальный") that selects the node with the best
   **windowed** speed-vs-liveness score, not the instantaneous winner.
2. Distinct from `sticky`: `sticky` = *don't move unless broken*; `optimal` = *move toward
   the proven-best over time*. (See §7 — explicitly not a duplicate.)
3. Explainable, like the other policies: every switch records why, with the effective
   latencies compared.
4. Available on **all channels** (Default + routed `ch-*`), same as `sticky`/`manual`.
5. Cheap: reuse the latency the background prober already keeps fresh — no extra probe storm.

### Non-goals (v1)

- No persistent (cross-restart) stats table. Stats are in-memory per controller; they
  survive config reloads (controllers are not recreated on reload) but reset on a server
  restart. A durable `node_stats` table is a possible phase 2 (§9).
- No "all-time" win counter. Rejected in §3 in favour of a decaying window (staleness /
  fairness-to-new-nodes / persistence cost). The user-facing framing "самый быстрый за
  всё время" is realized as "consistently the best over a recent window".
- No per-node manual weighting / pinning inside `optimal` (that's `manual`).

## 3. The metric — effective latency (EWMA)

Per candidate node the controller maintains two exponentially-weighted moving averages,
updated once per tick from the group view mihomo/​the prober already produced:

- `ewmaLatency` — mean latency over **successful** measurements (ms).
- `ewmaSuccess` — fraction of measurements that succeeded (0..1), hit = 1 / miss (null or
  timeout) = 0.

Both use the same smoothing factor `α`, derived from a fixed half-life so the knob count
stays low: `α = 1 − 2^(−intervalSec / halfLifeSec)`, `halfLifeSec = 300` (5 min) constant
in v1. So ~5 min of history dominates the score; older samples decay away.

**Score = effective latency**, a single intuitive number that folds in liveness:

```
effLatency(node) = ewmaLatency(node) / max(ewmaSuccess(node), ε)      # ε = 0.05
```

A flaky node is penalized proportionally: 50 % success doubles its effective latency, so a
fast-but-unreliable node loses to a slightly-slower-but-solid one — exactly the wanted
"optimal speed + liveness" trade-off. A node with no successful measurement yet
(`ewmaSuccess ≈ 0`) sorts last and is never selected until it proves itself.

**Rejected alternatives:**

- *All-time win count* — stale (last week's champion keeps the lead), unfair to newly
  added nodes, and needs persistence. Rejected (see §2 non-goals).
- *Windowed win count* — a noisier proxy for the same thing; a single-ms lead counts as a
  full "win". EWMA effective-latency is smoother and already encodes the margin.

## 4. Controller behaviour — `tickOptimal`

`optimal` is **controller-driven** (like `sticky`/`manual`): the channel group is a plain
`select` and our controller issues the selection. It health-checks on the channel's own
cadence (`intervalSec`), throttled exactly like `sticky`/`manual` in `tick()`.

Each tick:

1. `candidates = selectableNames(view)` (drops pseudo groups). Empty → return.
2. For every candidate read its current delay from `view.all` (mihomo history via
   `toGroupView`, kept fresh by the prober). Update `ewmaLatency` (on a hit) and
   `ewmaSuccess` (hit/miss) for that node. Nodes absent from the view this tick get no
   update (their EWMA simply ages on the next hit).
3. Compute `effLatency` for each candidate; `best = argmin`.
4. `active = view.autoNow`.
   - No valid active (null / not a candidate) → `select(best)`, record `initial: best`.
   - Else switch to `best` **only if** `effLatency(active) − effLatency(best) > toleranceMs`
     (reuse the familiar tolerance as the switch margin, now on the *smoothed* number, so
     it actually suppresses flapping instead of chasing noise). Otherwise hold.
5. Record the decision with both effective latencies:
   `optimal: A → B (312 vs 418 ms eff)`.

Because the comparison is on smoothed effective latency with a margin, momentary spikes on
the active node don't trigger a move, and a genuinely better node wins only once its
*windowed* advantage exceeds the margin — no url-test flapping.

`reset()` (called on `channels.setPolicy`) clears the per-node EWMA maps too, so switching
policy starts the window fresh.

## 5. Schema & config touch points

**`packages/shared/src/schemas.ts`** — add `optimalPolicySchema` to the union:

```ts
export const optimalPolicySchema = z.object({
  kind: z.literal("optimal"),
  testUrl: z.string().min(1),
  intervalSec: z.number().int().min(1),
  toleranceMs: z.number().int().min(0), // switch margin on effective (smoothed) latency
});
```

`halfLifeSec` and `ε` are constants in v1 (not exposed) to keep the UI to three knobs,
matching `sticky`'s density. `defaults.ts` gets `DEFAULT_OPTIMAL_POLICY`.

**`multiConfig.ts` / `config.ts`** — `groupFor` already maps every non-`speed` kind to a
`select` group, and `urlTestTuning` already falls back to the default tuning for the
collapsed subgroups. So `optimal` needs **no config-generation change** — it produces the
same `select` top-level group as `sticky`/`manual`.

**`controller.ts`** — `tick()` gains an `optimal` branch (throttled like sticky/manual)
delegating to `tickOptimal`; add the per-node EWMA state + `reset()` clearing.

**`service.ts` `policyProbe`** — `optimal` has `testUrl`/`intervalSec`, so the existing
non-`manual` branch already returns them correctly (used by the prober + decision-log URL).

**No change** to the registry wiring — `runOnce` already ticks every channel controller.

## 6. UI (`packages/web`)

- `PolicyEditor.tsx` — add the «Оптимальный» option to the policy segmented control, with
  the three fields (проверочный URL, интервал, допуск) — identical control types to the
  existing policies (measure-don't-invent: reuse the same rows). Copy: a one-line
  description «Держит стабильно быстрый узел за последние минуты; переключается только при
  устойчивом преимуществе другого».
- Decision-log line renders as-is (it's just `entry.reason`).
- `NodesScreen` active-node card: `optimal` is controller-selected, so it shows «выбран
  автоматически» like `speed`/`sticky`.

## 7. Why this is NOT a duplicate of `sticky` (по скорости)

| | trigger to **leave** current | reacts to slow-but-alive current | flapping |
|---|---|---|---|
| `speed` | another node faster by tolerance *now* | switches away instantly | yes (noise) |
| `sticky` (fastest) | current **fails** health-check ×N | never leaves | no |
| **`optimal`** | another node better by margin on **windowed** eff-latency | leaves once the other is durably better | no (smoothed + margin) |

`sticky` is liveness-hysteresis ("hold until broken"); `optimal` is statistics-hysteresis
("hold until out-competed over a window"). Different decision function, different outcome.

## 8. Testing

- `controller.test.ts` (extend the harness with a delay-feeding view sequence):
  - picks the lowest effective-latency node initially;
  - a node with lower raw latency but poor success rate loses to a solid slower node;
  - holds the current node while a challenger's windowed advantage stays ≤ tolerance
    (no flapping on momentary spikes);
  - switches once the challenger's smoothed eff-latency beats current by > tolerance;
  - `reset()` clears the EWMA maps (post-`setPolicy` starts fresh).
- `registry.test.ts`: an `optimal` channel selects into its own group.
- `schemas.test.ts`: `optimal` round-trips through the discriminated union; a corrupt blob
  still falls back to `DEFAULT_SPEED_POLICY` (existing `rowToChannel` guard).

## 9. Phasing

- **Phase 1 (this spec):** schema + `tickOptimal` (in-memory EWMA) + UI + tests.
- **Phase 2 (optional, later):** persist a compact `node_stats(name, ewmaLatencyMs,
  ewmaSuccess, updatedAt)` row per node so the window survives a server restart, and to
  power a future "node reliability" column. Deferred — anti-overengineering: in-memory is
  correct for one admin / hundreds of nodes, and reloads (the common case) already keep it.
