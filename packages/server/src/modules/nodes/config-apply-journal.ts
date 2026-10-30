import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultRouteSchema } from "@submerge/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { settings } from "../../db/schema.js";
import { readDefaultChannel } from "../channels/service.js";
import { getSetting, setSetting } from "../settings/service.js";

const APPLY_KEY = "internal.configApply";
const configIdentitySchema = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/u),
    defaultRoute: defaultRouteSchema,
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    configPath: z.string().min(1),
    accepted: configIdentitySchema.extend({ hash: configIdentitySchema.shape.hash.nullable() }),
    candidate: configIdentitySchema.nullable(),
  })
  .strict();

type ConfigApplyJournal = z.infer<typeof journalSchema>;
export interface ConfigApplyAttempt {
  journal: ConfigApplyJournal;
  previousJournal: ConfigApplyJournal | null;
  previousContent: string | null;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readContent(configPath: string): string | null {
  try {
    const bytes = readFileSync(configPath);
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes))
      throw new Error("Config file is not valid UTF-8");
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readJournal(db: Db): ConfigApplyJournal | null {
  const row = db.select().from(settings).where(eq(settings.key, APPLY_KEY)).get();
  if (!row) return null;
  const raw = getSetting(db, APPLY_KEY);
  if (raw === undefined) throw new Error("Invalid pending config apply journal");
  return journalSchema.parse(JSON.parse(raw));
}

function acceptedIdentity(
  journal: ConfigApplyJournal,
  configPath: string,
  content: string | null,
): ConfigApplyJournal["accepted"] {
  if (journal.configPath !== resolve(configPath))
    throw new Error("Pending config apply belongs to another config path");
  const hash = content === null ? null : contentHash(content);
  if (hash === journal.accepted.hash) return journal.accepted;
  if (journal.candidate && hash === journal.candidate.hash) return journal.candidate;
  throw new Error("Config file does not match the pending apply journal");
}

// Bootstrap may load the previous file while SQLite already contains the desired
// settings. This proof changes validation context, never marks an apply successful.
export function readConfigApplyRecovery(db: Db, configPath: string) {
  const journal = readJournal(db);
  return journal
    ? {
        pending: true,
        defaultRoute: acceptedIdentity(journal, configPath, readContent(configPath)).defaultRoute,
      }
    : { pending: false, defaultRoute: readDefaultChannel(db).defaultRoute };
}

// Called inside the same SQLite transaction as the caller's staged mutation.
export function beginConfigApply(db: Db, configPath: string): ConfigApplyAttempt {
  const previousJournal = readJournal(db);
  const previousContent = readContent(configPath);
  const accepted = previousJournal
    ? acceptedIdentity(previousJournal, configPath, previousContent)
    : {
        hash: previousContent === null ? null : contentHash(previousContent),
        defaultRoute: readDefaultChannel(db).defaultRoute,
      };
  const journal: ConfigApplyJournal = {
    version: 1,
    id: randomUUID(),
    configPath: resolve(configPath),
    accepted,
    candidate: null,
  };
  setSetting(db, APPLY_KEY, JSON.stringify(journal));
  return { journal, previousJournal, previousContent };
}

export function recordConfigApplyCandidate(db: Db, configPath: string, content: string): void {
  const journal = readJournal(db);
  if (!journal || journal.configPath !== resolve(configPath))
    throw new Error("Missing pending config apply journal");
  setSetting(
    db,
    APPLY_KEY,
    JSON.stringify({
      ...journal,
      candidate: { hash: contentHash(content), defaultRoute: readDefaultChannel(db).defaultRoute },
    }),
  );
}

export function finishConfigApply(db: Db, attempt: ConfigApplyAttempt, rollback = false): void {
  const current = readJournal(db);
  if (current?.id !== attempt.journal.id)
    throw new Error("Pending config apply changed during activation");
  if (!rollback) {
    const content = readContent(current.configPath);
    const expected = current.candidate ?? current.accepted;
    if ((content === null ? null : contentHash(content)) !== expected.hash)
      throw new Error("Activated config is not durable");
  }
  if (rollback && attempt.previousJournal)
    setSetting(db, APPLY_KEY, JSON.stringify(attempt.previousJournal));
  else db.delete(settings).where(eq(settings.key, APPLY_KEY)).run();
}
