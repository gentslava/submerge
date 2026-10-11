import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { settings } from "../../db/schema.js";
import { setSetting } from "../settings/service.js";
import type { NetworkProfile } from "./engine-settings.js";
import {
  initializeNetworkSettings,
  readNetworkSettings,
  writeNetworkSettings,
} from "./settings.js";
export function writeNetworkProfile(db: Db, profile: NetworkProfile) {
  if (profile.profile === "proxy") {
    initializeNetworkSettings(db);
    writeNetworkSettings(db, { ...readNetworkSettings(db), mode: "proxy" });
  } else {
    db.delete(settings).where(eq(settings.key, "internal.networkSettings")).run();
    setSetting(db, "networkProfile", JSON.stringify(profile));
    initializeNetworkSettings(db);
  }
}
