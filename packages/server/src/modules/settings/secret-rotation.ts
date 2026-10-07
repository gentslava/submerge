import { randomUUID } from "node:crypto";
import { setSettingInput } from "@submerge/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  probeMihomoCredential,
  setMihomoSecret,
  setMihomoSecretRecovery,
} from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { settings } from "../../db/schema.js";
import { getSetting, setSetting } from "./service.js";

const ROTATION_KEY = "internal.mihomoSecretRotation";
const pendingMihomoSecretRotationSchema = z
  .object({
    id: z.uuid(),
    nextEffective: z.string(),
    nextStored: z.string(),
    previousEffective: z.string(),
    version: z.literal(2),
  })
  .strict();

export type PendingMihomoSecretRotation = z.infer<typeof pendingMihomoSecretRotationSchema>;
export interface MihomoSecretRotationAttempt {
  created: boolean;
  rotation: PendingMihomoSecretRotation;
}

export interface MihomoSecretConfigPreparation {
  pending: boolean;
  rollbackSafe: boolean;
  secret: string;
}

export type MihomoSecretRotationPersistenceState = "absent" | "committed" | "pending";

function confirmedSecret(db: Db): string {
  return getSetting(db, "mihomoSecret") || env.MIHOMO_SECRET;
}

function parsePending(raw: unknown): PendingMihomoSecretRotation | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("pending mihomo secret rotation is invalid");
  }
  const parsed = pendingMihomoSecretRotationSchema.safeParse(value);
  if (!parsed.success) throw new Error("pending mihomo secret rotation is invalid");
  return parsed.data;
}

function readPending(db: Db): PendingMihomoSecretRotation | null {
  return parsePending(getSetting(db, ROTATION_KEY));
}

function installRecoveryCredential(rotation: PendingMihomoSecretRotation): void {
  // Authentication alone is not a commit proof: the running engine may already
  // accept the new secret while the durable config file still contains the old
  // one. Promotion happens only after applyConfig verifies the file/reload path.
  setMihomoSecretRecovery(rotation.nextEffective, rotation.previousEffective);
}

function finalizeRotation(db: Db, rotation: PendingMihomoSecretRotation): boolean {
  const nextSetting = setSettingInput.parse({ key: "mihomoSecret", value: rotation.nextStored });
  const committed = db.transaction((tx) => {
    const raw = tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, ROTATION_KEY))
      .get()?.value;
    const current = parsePending(raw);
    if (current?.id !== rotation.id) return false;
    tx.insert(settings)
      .values(nextSetting)
      .onConflictDoUpdate({ target: settings.key, set: { value: nextSetting.value } })
      .run();
    tx.delete(settings).where(eq(settings.key, ROTATION_KEY)).run();
    return true;
  });
  if (committed) setMihomoSecret(rotation.nextEffective);
  return committed;
}

export function beginMihomoSecretRotation(
  db: Db,
  nextStoredValue: string,
): MihomoSecretRotationAttempt {
  setSettingInput.parse({ key: "mihomoSecret", value: nextStoredValue });
  const existing = readPending(db);
  if (existing) {
    if (existing.nextStored !== nextStoredValue) {
      throw new Error("mihomo secret rotation is already in progress");
    }
    installRecoveryCredential(existing);
    return { created: false, rotation: existing };
  }
  const rotation = pendingMihomoSecretRotationSchema.parse({
    id: randomUUID(),
    nextEffective: nextStoredValue || env.MIHOMO_SECRET,
    nextStored: nextStoredValue,
    previousEffective: confirmedSecret(db),
    version: 2,
  });
  setSetting(db, ROTATION_KEY, JSON.stringify(rotation));
  installRecoveryCredential(rotation);
  return { created: true, rotation };
}

export function getMihomoSecretRotationPersistenceState(
  db: Db,
  attempt: MihomoSecretRotationAttempt,
): MihomoSecretRotationPersistenceState {
  if (readPending(db)?.id === attempt.rotation.id) return "pending";
  return getSetting(db, "mihomoSecret") === attempt.rotation.nextStored ? "committed" : "absent";
}

export function rollbackMihomoSecretRotation(db: Db, attempt: MihomoSecretRotationAttempt): void {
  if (!attempt.created) return;
  const { rotation } = attempt;
  const removed = db.transaction((tx) => {
    const raw = tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, ROTATION_KEY))
      .get()?.value;
    const current = parsePending(raw);
    if (current?.id !== rotation.id) return false;
    tx.delete(settings).where(eq(settings.key, ROTATION_KEY)).run();
    return true;
  });
  if (removed) {
    setMihomoSecret(rotation.previousEffective);
  } else {
    restorePendingMihomoSecretRotation(db);
  }
}

async function credentialAuthenticates(secret: string, signal?: AbortSignal): Promise<boolean> {
  try {
    return await probeMihomoCredential(secret, signal);
  } catch {
    return false;
  }
}

export async function prepareMihomoSecretForConfig(
  db: Db,
  signal?: AbortSignal,
): Promise<MihomoSecretConfigPreparation> {
  const rotation = readPending(db);
  if (!rotation) return { pending: false, rollbackSafe: true, secret: confirmedSecret(db) };
  installRecoveryCredential(rotation);
  if (await credentialAuthenticates(rotation.nextEffective, signal)) {
    return { pending: true, rollbackSafe: false, secret: rotation.nextEffective };
  }
  if (await credentialAuthenticates(rotation.previousEffective, signal)) {
    return { pending: true, rollbackSafe: true, secret: rotation.nextEffective };
  }
  throw new Error("mihomo secret rotation recovery is blocked");
}

export async function confirmPendingMihomoSecretRotation(
  db: Db,
  signal?: AbortSignal,
): Promise<boolean> {
  const rotation = readPending(db);
  if (!rotation) return false;
  if (!(await credentialAuthenticates(rotation.nextEffective, signal))) return false;
  return finalizeRotation(db, rotation);
}

export function restorePendingMihomoSecretRotation(db: Db): boolean {
  const rotation = readPending(db);
  if (!rotation) {
    setMihomoSecret(confirmedSecret(db));
    return false;
  }
  installRecoveryCredential(rotation);
  return true;
}
