import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import {
  MAX_SETTING_KEY_BYTES,
  MAX_SETTING_VALUE_BYTES,
  setSettingInput,
  settingKeySchema,
  settingValueSchema,
} from "@submerge/shared";
import { and, eq, sql } from "drizzle-orm";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { settings } from "../../db/schema.js";

const INTERNAL_SETTING_PREFIX = "internal.";
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeCanonicalUtf8(value: Buffer | null): string | null {
  if (!Buffer.isBuffer(value)) return null;
  try {
    const decoded = fatalUtf8Decoder.decode(value);
    return Buffer.from(decoded, "utf8").equals(value) ? decoded : null;
  } catch {
    return null;
  }
}

export function isInternalSettingKey(key: string): boolean {
  return key.startsWith(INTERNAL_SETTING_PREFIX);
}

export function getSetting(db: Db, key: string): string | undefined {
  const parsedKey = settingKeySchema.safeParse(key);
  if (!parsedKey.success) return undefined;
  const row = db
    .select({
      value: sql<Buffer | null>`case
        when typeof(${settings.value}) = 'text'
          and instr(cast(${settings.value} as blob), x'00') = 0
          and length(cast(${settings.value} as blob)) <= ${MAX_SETTING_VALUE_BYTES}
          then case
            when length(cast(${settings.value} as blob)) = 0 then zeroblob(0)
            else substr(cast(${settings.value} as blob), 1, ${MAX_SETTING_VALUE_BYTES + 1})
          end
        else null
      end`,
    })
    .from(settings)
    .where(and(eq(settings.key, parsedKey.data), sql`typeof(${settings.key}) = 'text'`))
    .get();
  const parsedValue = settingValueSchema.safeParse(decodeCanonicalUtf8(row?.value ?? null));
  return parsedValue.success ? parsedValue.data : undefined;
}

export function getAllSettings(db: Db): Record<string, string> {
  const rows = db
    .select({
      key: sql<Buffer | null>`case
        when typeof(${settings.key}) = 'text'
          and instr(cast(${settings.key} as blob), x'00') = 0
          and length(cast(${settings.key} as blob)) between 1 and ${MAX_SETTING_KEY_BYTES}
          then substr(cast(${settings.key} as blob), 1, ${MAX_SETTING_KEY_BYTES + 1})
        else null
      end`,
      value: sql<Buffer | null>`case
        when typeof(${settings.value}) = 'text'
          and instr(cast(${settings.value} as blob), x'00') = 0
          and length(cast(${settings.value} as blob)) <= ${MAX_SETTING_VALUE_BYTES}
          then case
            when length(cast(${settings.value} as blob)) = 0 then zeroblob(0)
            else substr(cast(${settings.value} as blob), 1, ${MAX_SETTING_VALUE_BYTES + 1})
          end
        else null
      end`,
    })
    .from(settings)
    .all();
  const entries: Array<[string, string]> = [];
  for (const row of rows) {
    const key = settingKeySchema.safeParse(decodeCanonicalUtf8(row.key));
    const value = settingValueSchema.safeParse(decodeCanonicalUtf8(row.value));
    if (key.success && value.success) entries.push([key.data, value.data]);
  }
  return Object.fromEntries(entries);
}

// The UI-facing settings: stored DB values plus env-seeded/ensured fields. The mihomo
// secret falls back to env until set and is admin-viewable (single-admin tool) — keep
// the panel behind ADMIN_PASSWORD if it's network-exposed (see the deploy notes).
export function getSettingsView(db: Db): Record<string, string> {
  const publicSettings = Object.fromEntries(
    Object.entries(getAllSettings(db)).filter(([key]) => !isInternalSettingKey(key)),
  );
  return {
    ...publicSettings,
    hwid: getOrCreateHwid(db),
    mihomoSecret: getSetting(db, "mihomoSecret") || env.MIHOMO_SECRET,
    proxyEndpoint: getSetting(db, "proxyEndpoint") || env.PROXY_ENDPOINT,
  };
}

export function setSetting(db: Db, key: string, value: string): void {
  const parsed = setSettingInput.parse({ key, value });
  db.insert(settings)
    .values(parsed)
    .onConflictDoUpdate({ target: settings.key, set: { value: parsed.value } })
    .run();
}

export function getOrCreateInternalSecret(db: Db, key: string): string {
  if (!isInternalSettingKey(key)) throw new Error("internal secret key is not protected");
  const existing = getSetting(db, key);
  if (existing && /^[A-Za-z0-9_-]{43}$/u.test(existing)) return existing;
  const secret = randomBytes(32).toString("base64url");
  setSetting(db, key, secret);
  return secret;
}

// Stable per-instance HWID (ADR-0002). Prefer DB, then the mirror file, else
// generate. Always persist to DB and mirror to the file (best-effort) so the
// happ-decoder sidecar — which reads HWID_FILE unchanged — uses the same value.
export function getOrCreateHwid(db: Db, file: string = env.HWID_FILE): string {
  const existing = getSetting(db, "hwid");
  if (existing) {
    mirrorHwid(file, existing);
    return existing;
  }
  let hwid = "";
  if (existsSync(file)) {
    try {
      hwid = readFileSync(file, "utf8").trim();
    } catch {
      /* unreadable; fall through to generate */
    }
  }
  if (!hwid) hwid = randomBytes(16).toString("hex");
  setSetting(db, "hwid", hwid);
  mirrorHwid(file, hwid);
  return hwid;
}

function mirrorHwid(file: string, hwid: string): void {
  try {
    writeFileSync(file, hwid);
  } catch {
    /* file path not writable (e.g. local dev without /mihomo) — DB is source of truth */
  }
}
