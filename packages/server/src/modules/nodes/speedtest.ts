import { PROBE_GROUP } from "@submerge/shared";
import { measureDownload, selectProxy } from "../../clients/mihomo.js";
import type { Db } from "../../db/client.js";
import { setNodeBandwidth } from "./bandwidth.js";

export interface SpeedTestResult {
  mbps: number;
  testedAt: number; // epoch ms
}

// Probes share one PROBE group + saturate the link, so run at most one at a time:
// each request queues behind the previous (single-admin scale — a plain promise
// chain is enough; a failed run doesn't block the next).
let chain: Promise<unknown> = Promise.resolve();

async function runSpeedTest(db: Db, node: string): Promise<SpeedTestResult> {
  // Pin the hidden PROBE group to this node; the config's `DOMAIN,<host>,PROBE`
  // rule then routes the fixed-size download through it.
  await selectProxy(PROBE_GROUP, node);
  try {
    const { mbps } = await measureDownload();
    const testedAt = Date.now();
    setNodeBandwidth(db, node, mbps, testedAt);
    return { mbps, testedAt };
  } finally {
    // Restore PROBE → REJECT (its default): the test host is only reachable while a
    // test is actively pinning a node, never leaked direct or tunneled otherwise.
    await selectProxy(PROBE_GROUP, "REJECT").catch(() => {});
  }
}

// Run an on-demand throughput test for `node`, serialized behind any in-flight test,
// and cache the result. Real quota burn — the caller (UI) gates it behind a warning.
export function speedTestNode(db: Db, node: string): Promise<SpeedTestResult> {
  const run = chain.then(
    () => runSpeedTest(db, node),
    () => runSpeedTest(db, node),
  );
  chain = run.catch(() => {});
  return run;
}
