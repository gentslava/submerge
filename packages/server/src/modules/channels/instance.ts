import { getDelay, selectProxy } from "../../clients/mihomo.js";
import { db } from "../../db/client.js";
import { ChannelController } from "./controller.js";
import { DEFAULT_CHANNEL_ID, readDefaultChannel, setChannelLastReason } from "./service.js";

// The single controller for the Default channel (Phase 2). Deps bind it to the real
// db + mihomo client; `probe` maps a timeout/unreachable node to null so the sticky
// failure counter advances instead of throwing.
export const channelController = new ChannelController({
  readChannel: () => readDefaultChannel(db),
  probe: async (name, url) => {
    try {
      const { delay } = await getDelay(name, url);
      return delay > 0 ? delay : null;
    } catch {
      return null;
    }
  },
  select: selectProxy,
  persistReason: (reason, at) => setChannelLastReason(db, DEFAULT_CHANNEL_ID, reason, at),
  now: () => Date.now(),
});
