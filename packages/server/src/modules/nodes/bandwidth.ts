import { BANDWIDTH_MAX_AGE_MS } from "@submerge/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { nodeBandwidth } from "../../db/schema.js";

// Stays in sync with the table shape. `testedAt` is epoch ms.
export type NodeBandwidth = typeof nodeBandwidth.$inferSelect;

// Upsert a node's last measured download throughput (Mbps).
export function setNodeBandwidth(db: Db, nodeName: string, mbps: number, testedAt: number): void {
  db.insert(nodeBandwidth)
    .values({ nodeName, mbps, testedAt })
    .onConflictDoUpdate({ target: nodeBandwidth.nodeName, set: { mbps, testedAt } })
    .run();
}

// Cached Mbps for one node, or null when never measured. When `now` is given, a
// reading older than BANDWIDTH_MAX_AGE_MS is treated as absent — so a stale peak
// stops biasing selection (and the passive path resets it from fresh samples).
export function getNodeBandwidth(db: Db, nodeName: string, now?: number): number | null {
  const row = db.select().from(nodeBandwidth).where(eq(nodeBandwidth.nodeName, nodeName)).get();
  if (!row) return null;
  if (now !== undefined && now - row.testedAt > BANDWIDTH_MAX_AGE_MS) return null;
  return row.mbps;
}

// All cached measurements — surfaced to the UI (value + age per node).
export function listNodeBandwidth(db: Db): NodeBandwidth[] {
  return db.select().from(nodeBandwidth).all();
}
