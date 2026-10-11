import { randomUUID } from "node:crypto";
import { type NetworkSettings, networkSettingsSchema } from "@submerge/shared";
import { TRPCError } from "@trpc/server";
import { getRuntimeConfig, queryDnsResolution } from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { applyConfig, collectActiveRoutingInputs } from "../nodes/service.js";
import { checkGatewayReadiness } from "./readiness.js";
import {
  assertIndependentLocalDns,
  gatewayApplyState,
  initializeNetworkSettings,
  readGatewayRuntimeSettings,
  readNetworkProfile,
  readNetworkSettings,
  writeNetworkSettings,
} from "./settings.js";

export function getGatewayConfiguration(db: Db) {
  return readNetworkSettings(db);
}

export async function configureGateway(db: Db, input: NetworkSettings) {
  const next = networkSettingsSchema.parse(input);
  if (next.mode === "tun" && !env.ADMIN_PASSWORD)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Для TUN нужен пароль входа в Submerge. Задайте его при установке сервера.",
    });
  initializeNetworkSettings(db);
  const previous = readNetworkSettings(db);
  try {
    const result = await applyConfig(db, undefined, undefined, {
      force: true,
      stageConfigMutation: () => {
        writeNetworkSettings(db, next);
        const runtime = readGatewayRuntimeSettings(db);
        if (!runtime) throw new Error("Missing saved connection settings");
        assertIndependentLocalDns(runtime);
        return () => writeNetworkSettings(db, previous);
      },
    });
    if (!result.applied) throw new Error("Engine did not apply connection mode");
    if (
      next.localResolvers.length > 0 &&
      next.localResolvers.join() !== previous.localResolvers.join()
    ) {
      // A fresh local name exercises the newly selected resolver, not a warm cache.
      if (!(await queryDnsResolution(`submerge-${randomUUID()}.lan`)))
        throw new Error("Home DNS did not answer");
    }
    return result;
  } catch (cause) {
    writeNetworkSettings(db, previous);
    // A lost engine response is ambiguous. Re-apply the previous settings before
    // reporting failure; neither the database nor the UI claims the new mode.
    try {
      await applyConfig(db, undefined, undefined, { force: true });
    } catch {
      /* Health reports the engine failure. */
    }
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        next.localResolvers.join() !== previous.localResolvers.join()
          ? "Не удалось сохранить DNS. Проверьте адрес сервера и его доступность."
          : next.mode === "tun"
            ? "Не удалось включить TUN. Проверьте работу сервера и поддержку TUN в установке Submerge."
            : "Не удалось переключиться на прокси. Проверьте работу сервера.",
      cause,
    });
  }
}

export async function gatewayReadiness(db: Db) {
  try {
    const profile = readNetworkProfile(db);
    const preferences = readGatewayRuntimeSettings(db);
    if (!preferences) {
      const runtime = await getRuntimeConfig();
      const ok = runtime.tun !== true;
      return { profile: "proxy" as const, ready: ok, checks: [{ name: "runtime", ok }] };
    }
    const defaultChannel = collectActiveRoutingInputs(db).inputs.find(
      (channel) => channel.isDefault,
    );
    const group = defaultChannel?.target === "proxy" ? defaultChannel.groupName : "PROXY";
    return checkGatewayReadiness(
      preferences,
      gatewayApplyState(db),
      group,
      undefined,
      profile.profile === "gateway",
    );
  } catch {
    return {
      profile: "gateway" as const,
      ready: false,
      checks: [{ name: "configuration", ok: false }],
    };
  }
}
