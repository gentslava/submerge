import { randomBytes, randomUUID } from "node:crypto";
import { setSettingInput } from "@submerge/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  buildMihomoAuthorization,
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

export function readMihomoBootstrapSecret(db: Db): string {
  return readPending(db)?.nextEffective ?? confirmedSecret(db);
}

// Keep a durable old/new pair until the live apply path proves the new credential,
// including application startup without init and interrupted legacy upgrades.
export function prepareMihomoSecretForBootstrap(db: Db): string {
  const pending = db.transaction(
    () => {
      const current = readPending(db);
      if (!current || current.nextStored) return current;
      // Legacy Proxy resets left the stored value blank. Persist their captured
      // seed, or generate one for an empty replacement. An unauthenticated engine
      // accepts that candidate; the old key covers a reset not yet applied.
      const secret = current.nextEffective || randomBytes(32).toString("hex");
      const replacement = { ...current, nextEffective: secret, nextStored: secret };
      setSetting(db, ROTATION_KEY, JSON.stringify(replacement));
      return replacement;
    },
    { behavior: "immediate" },
  );
  if (pending) {
    installRecoveryCredential(pending);
    return pending.nextEffective;
  }
  const stored = getSetting(db, "mihomoSecret");
  if (stored) return stored;
  const seed = env.MIHOMO_SECRET;
  if (seed) {
    buildMihomoAuthorization(seed);
    return seed;
  }
  return beginMihomoSecretRotation(db, randomBytes(32).toString("hex")).rotation.nextEffective;
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
  const existing = readPending(db);
  // Retain the confirmed effective secret through env changes.
  // Capture a blank reset now, so journal promotion is still a single transaction.
  const defaultSecret = env.MIHOMO_SECRET || confirmedSecret(db);
  const nextStored =
    nextStoredValue === ""
      ? (existing?.nextStored ?? (defaultSecret || randomBytes(32).toString("hex")))
      : nextStoredValue;
  setSettingInput.parse({ key: "mihomoSecret", value: nextStored });
  if (existing) {
    if (existing.nextStored !== nextStored) {
      throw new Error("mihomo secret rotation is already in progress");
    }
    installRecoveryCredential(existing);
    return { created: false, rotation: existing };
  }
  buildMihomoAuthorization(nextStored);
  const rotation = pendingMihomoSecretRotationSchema.parse({
    id: randomUUID(),
    nextEffective: nextStored || env.MIHOMO_SECRET,
    nextStored,
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
