# «Оптимальный» policy — historical-winner node selection — design

- **Date:** 2026-07-07 (v2 rework 2026-07-08: sample-based window, relative margin, slow-but-alive escape)
- **Status:** Implemented
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

Both use the same smoothing factor `α`, derived from a half-life measured in
**measurements**, not seconds: `α = 1 − 2^(−1 / OPTIMAL_EWMA_HALF_LIFE_SAMPLES)`,
`OPTIMAL_EWMA_HALF_LIFE_SAMPLES = 8`. Because `tickOptimal` runs once per «Интервал
проверки», one tick = one sample, so the window is ~15–20 measurements **regardless of the
interval setting** — a 10 s interval and a 5 min interval get the same-shaped window.
(v2 change: the original `α = 1 − 2^(−intervalSec/300s)` meant 30 samples at a 10 s interval
but only 1 at 5 min — over-smoothed for fast intervals, which made the policy unresponsive.)

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
4. `active = view.autoNow`. No valid active (null / not a candidate) → `select(best)`,
   record `initial: best`. Otherwise compute `target` = the best (lowest eff) candidate that
   answers **right now** (`delay != null`, excluding `active`) — we never switch onto a node
   that's momentarily down — and try three switch paths, in order:
   - **(1) Liveness failover** — a *dead* active node (timed out) flees on the first miss
     (`OPTIMAL_ACTIVE_FAILURE_THRESHOLD = 1`) to `target`: `optimal: A down → B`. A dead node
     keeps its last good latency while its success EWMA decays slowly, so its eff would take
     minutes to climb past a live node — far too long to hold a dead exit.
   - **(2) Slow-but-alive escape** — the active node is *up* but its **raw current** latency
     is far worse than `target`'s **raw** latency (`activeRaw > targetRaw × (1 + OPTIMAL_SLOW_FACTOR)`,
     `SLOW_FACTOR = 0.35`) for `OPTIMAL_SLOW_TICKS = 2` consecutive ticks → switch:
     `optimal: A slow (358 ms) → B`. Raw-to-raw (not smoothed) so a node with a good EWMA
     history but a bad current ping still counts as slow. The 2-tick streak avoids a single blip.
   - **(3) Proactive switch** — `target` beats the active node by a **relative** margin on the
     active score `max(activeEff, activeRaw)`: `targetEff ≤ activeScore × (1 − OPTIMAL_SWITCH_MARGIN_PCT)`,
     `MARGIN_PCT = 0.10`. Using the worse of smoothed eff and current raw prevents a good
     history from masking an acute spike (the prod case: 358 ms raw vs 259 ms best while
     activeEff was still ~280). Records `optimal: A → B (…eff)`.

The layering is deliberate — **liveness first, then acute slowness, then steady speed** —
so the policy is *proactive* (moves toward a durably- or acutely-better node) without the
url-test flapping: the relative margin + the 2-tick slow streak provide the hysteresis.

**v2 change (why the rework):** the original design used a single absolute `toleranceMs` on
the smoothed eff. In a tightly-clustered fleet (nodes at 280–360 ms) a 50 ms margin was
almost never crossed by a steady difference, and the 300 s (=30-sample) window absorbed even
huge spikes — so in practice the *only* switch that fired was the death failover. The
sample-based window (responsive), the relative margin (crosses in a fast fleet), and the
slow-but-alive escape (catches spikes) together restore the intended proactivity.

**v2.1 fix (2026-07-08):** live prod still held a spiking node (358 ms raw, 259 ms best)
because `activeEff` lagged behind a good EWMA history — the proactive margin compared only
the smoothed score, and the slow escape compared raw against `targetEff × 1.5` (388 ms
threshold for a 259 ms best). Fix: proactive uses `max(eff, raw)` for the active side;
slow escape compares raw-to-raw with `SLOW_FACTOR = 0.35` (~35 % worse).

**Freshness (why passive reading is safe).** `tickOptimal` reads latencies from the group
view rather than probing — the background prober already keeps every node measured. The
prober probes `PROXY.all`, and the Default channel DEFINES the whole (non-excluded)
inventory into `PROXY` (the "define+ping all nodes" model), so *every* candidate of *every*
channel is kept fresh regardless of pools — no `+∞` "never measured → pick the first node"
degradation on routed channels. **v1 limitation:** the prober measures on the *Default*
policy's test URL, so a routed `optimal` channel configured with a *distinct* test URL is
scored on the freshest available series (the shared history, i.e. the Default URL) until
that URL is exercised — the same per-URL/shared-history fallback the node view already uses
(`toNodeView`). Acceptable for v1; a per-channel prober URL is out of scope.

`reset()` (called on `channels.setPolicy`) clears the per-node EWMA maps too, so switching
policy starts the window fresh.

## 5. Schema & config touch points

**`packages/shared/src/schemas.ts`** — add `optimalPolicySchema` to the union:

```ts
export const optimalPolicySchema = z.object({
  kind: z.literal("optimal"),
  testUrl: z.string().min(1),
  intervalSec: z.number().int().min(1),
  // No toleranceMs: the switch margin is RELATIVE (a % of the current node's eff) and the
  // EWMA window is in samples — both code constants, not per-policy knobs. A legacy row
  // still carrying toleranceMs parses fine (z.object strips the unknown key).
});
```

The window (`OPTIMAL_EWMA_HALF_LIFE_SAMPLES`), margin (`OPTIMAL_SWITCH_MARGIN_PCT`), slow
factor/ticks and success-floor `ε` are constants in `defaults.ts` (not exposed), so the
optimal UI shows just URL + interval. `defaults.ts` gets `DEFAULT_OPTIMAL_POLICY`.

**`multiConfig.ts` / `config.ts`** — `groupFor` maps every non-`speed` kind to a `select`
group; `urlTestTuning` now uses the policy's own `testUrl`/`intervalSec` (tolerance falls
back to the default, since `optimal` has no `toleranceMs`) so collapsed subgroups probe at
the channel's interval. `optimal` produces the same `select` top-level group as
`sticky`/`manual`.

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
