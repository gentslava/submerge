import type { ConnectionItem } from "@submerge/shared";
import { getConnections, type MihomoConnection } from "../../clients/mihomo.js";

// Map a raw mihomo connection to the view row. Honesty rules for our server
// topology: `process` is usually empty (mihomo can't resolve a LAN device's
// process over SOCKS), so ИСТОЧНИК falls back to the client's source IP; the
// outbound node is `chains[0]` (the actual proxy, not the entry group).
export function toConnectionItem(c: MihomoConnection): ConnectionItem {
  const m = c.metadata;
  return {
    id: c.id,
    source: m.process.trim() || m.sourceIP || "—",
    host: m.host.trim() || m.destinationIP || "—",
    destIp: m.destinationIP,
    port: m.destinationPort,
    network: m.network.toLowerCase() === "udp" ? "udp" : "tcp",
    node: c.chains[0] ?? "",
    up: c.upload,
    down: c.download,
    start: c.start,
  };
}

export async function listConnections(): Promise<{ connections: ConnectionItem[] }> {
  const raw = await getConnections();
  return { connections: raw.map(toConnectionItem) };
}
