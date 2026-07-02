import { getDelay, selectProxy } from "../../clients/mihomo.js";
import { db } from "../../db/client.js";
import { ChannelController } from "./controller.js";
import { DEFAULT_CHANNEL_ID, readDefaultChannel, setChannelLastReason } from "./service.js";

// Maps a timeout (delay <= 0) or an unreachable node (getDelay throws) to null so
// the sticky failure counter advances instead of throwing. Exported for tests.
export async function probeDelay(name: string, url: string): Promise<number | null> {
  try {
    const { delay } = await getDelay(name, url);
    return delay > 0 ? delay : null;
  } catch {
    return null;
  }
}

// The single controller for the Default channel (Phase 2). Deps bind it to the real
// db + mihomo client.
export const channelController = new ChannelController({
  readChannel: () => readDefaultChannel(db),
  probe: probeDelay,
  select: selectProxy,
  persistReason: (reason, at) => setChannelLastReason(db, DEFAULT_CHANNEL_ID, reason, at),
  now: () => Date.now(),
});
