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

// Cached Mbps for one node, or null when it has never been measured.
export function getNodeBandwidth(db: Db, nodeName: string): number | null {
  const row = db.select().from(nodeBandwidth).where(eq(nodeBandwidth.nodeName, nodeName)).get();
  return row?.mbps ?? null;
}

// All cached measurements — surfaced to the UI (value + age per node).
export function listNodeBandwidth(db: Db): NodeBandwidth[] {
  return db.select().from(nodeBandwidth).all();
}
