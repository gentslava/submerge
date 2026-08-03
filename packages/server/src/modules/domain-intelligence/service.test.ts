import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import { domainDailyStats, domainObservations } from "../../db/schema.js";
import {
  type DomainObservation,
  fingerprintObservation,
  type ObservationSource,
} from "./observer.js";
import { recordObservation } from "./service.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

function migratedDb(): Db {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder });
  return db;
}

function observation(
  observedAt: number,
  source: ObservationSource = "mihomo-log",
  fqdn = "api.service.example",
): DomainObservation {
  return {
    fqdn,
    observedAt,
    transport: "tcp",
    source,
    fingerprint: fingerprintObservation(fqdn, "tcp", observedAt),
  };
}

describe("domain observation persistence", () => {
  it("stores one privacy-bounded observation and UTC daily aggregate", () => {
    const db = migratedDb();
    const observedAt = Date.parse("2026-08-03T23:59:59.000Z");

    expect(recordObservation(db, observation(observedAt))).toEqual({
      status: "inserted",
      dailyCount: 1,
    });
    expect(db.select().from(domainObservations).all()).toEqual([
      {
        fingerprint: fingerprintObservation("api.service.example", "tcp", observedAt),
        fqdn: "api.service.example",
        observedAt,
        lastSeenAt: observedAt,
        transport: "tcp",
        source: "mihomo-log",
        count: 1,
      },
    ]);
    expect(db.select().from(domainDailyStats).orderBy(domainDailyStats.day).all()).toEqual([
      {
        day: "2026-08-03",
        fqdn: "api.service.example",
        connectionCount: 1,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      },
    ]);
  });

  it("reconciles an exact source-independent fingerprint without incrementing count", () => {
    const db = migratedDb();
    const first = observation(10_000, "mihomo-log");
    const duplicate = observation(20_000, "connection-snapshot");
    expect(first.fingerprint).toBe(duplicate.fingerprint);

    expect(recordObservation(db, first).status).toBe("inserted");
    expect(recordObservation(db, duplicate)).toEqual({ status: "duplicate", dailyCount: 1 });

    expect(db.select().from(domainObservations).all()).toMatchObject([
      { observedAt: 10_000, lastSeenAt: 20_000, source: "mihomo-log", count: 1 },
    ]);
    expect(db.select().from(domainDailyStats).all()).toMatchObject([
      { connectionCount: 1, firstSeenAt: 10_000, lastSeenAt: 20_000 },
    ]);
  });

  it("reconciles cross-source observations across an adjacent bucket boundary", () => {
    const db = migratedDb();
    const first = observation(29_999, "connection-snapshot");
    const adjacent = observation(30_001, "mihomo-log");
    expect(first.fingerprint).not.toBe(adjacent.fingerprint);

    recordObservation(db, first);
    expect(recordObservation(db, adjacent)).toEqual({ status: "reconciled", dailyCount: 1 });

    expect(db.select().from(domainObservations).all()).toHaveLength(1);
    expect(db.select().from(domainDailyStats).get()?.connectionCount).toBe(1);
  });

  it("counts distinct same-source observations on opposite sides of a bucket boundary", () => {
    const db = migratedDb();
    recordObservation(db, observation(29_999));
    expect(recordObservation(db, observation(30_001))).toEqual({
      status: "inserted",
      dailyCount: 2,
    });

    expect(db.select().from(domainObservations).all()).toHaveLength(2);
    expect(db.select().from(domainDailyStats).get()?.connectionCount).toBe(2);
  });

  it("keeps UTC days and FQDNs as independent aggregates", () => {
    const db = migratedDb();
    recordObservation(db, observation(Date.parse("2026-08-03T23:59:59.999Z")));
    recordObservation(db, observation(Date.parse("2026-08-04T00:00:00.001Z")));
    recordObservation(
      db,
      observation(Date.parse("2026-08-04T01:00:00.000Z"), "mihomo-log", "other.example"),
    );

    expect(db.select().from(domainDailyStats).all()).toMatchObject([
      { day: "2026-08-03", fqdn: "api.service.example", connectionCount: 1 },
      { day: "2026-08-04", fqdn: "api.service.example", connectionCount: 1 },
      { day: "2026-08-04", fqdn: "other.example", connectionCount: 1 },
    ]);
  });

  it("chooses the same canonical UTC day regardless of cross-source ingest order", () => {
    const log = observation(Date.parse("2026-08-04T00:00:00.001Z"), "mihomo-log");
    const snapshot = observation(Date.parse("2026-08-03T23:59:59.999Z"), "connection-snapshot");
    const capture = (ordered: DomainObservation[]) => {
      const db = migratedDb();
      for (const item of ordered) recordObservation(db, item);
      return {
        observations: db.select().from(domainObservations).all(),
        daily: db.select().from(domainDailyStats).all(),
      };
    };

    const logFirst = capture([log, snapshot]);
    const snapshotFirst = capture([snapshot, log]);

    expect(logFirst).toEqual(snapshotFirst);
    expect(logFirst).toEqual({
      observations: [
        {
          fingerprint: snapshot.fingerprint,
          fqdn: snapshot.fqdn,
          observedAt: snapshot.observedAt,
          lastSeenAt: log.observedAt,
          transport: "tcp",
          source: "connection-snapshot",
          count: 1,
        },
      ],
      daily: [
        {
          day: "2026-08-03",
          fqdn: snapshot.fqdn,
          connectionCount: 1,
          firstSeenAt: snapshot.observedAt,
          lastSeenAt: log.observedAt,
        },
      ],
    });
  });

  it("rebuilds the old aggregate when canonical reconciliation crosses UTC midnight", () => {
    const db = migratedDb();
    const anotherConnection = observation(Date.parse("2026-08-04T01:00:00.000Z"));
    const log = observation(Date.parse("2026-08-04T00:00:00.001Z"), "mihomo-log");
    const snapshot = observation(Date.parse("2026-08-03T23:59:59.999Z"), "connection-snapshot");

    recordObservation(db, anotherConnection);
    recordObservation(db, log);
    recordObservation(db, snapshot);

    expect(db.select().from(domainDailyStats).orderBy(domainDailyStats.day).all()).toEqual([
      {
        day: "2026-08-03",
        fqdn: snapshot.fqdn,
        connectionCount: 1,
        firstSeenAt: snapshot.observedAt,
        lastSeenAt: log.observedAt,
      },
      {
        day: "2026-08-04",
        fqdn: anotherConnection.fqdn,
        connectionCount: 1,
        firstSeenAt: anotherConnection.observedAt,
        lastSeenAt: anotherConnection.observedAt,
      },
    ]);
  });

  it("rolls back the observation when the daily aggregate write aborts", () => {
    const db = migratedDb();
    db.$client.exec(`
      CREATE TRIGGER abort_domain_daily_insert
      BEFORE INSERT ON domain_daily_stats
      BEGIN
        SELECT RAISE(ABORT, 'forced daily failure');
      END;
    `);

    expect(() => recordObservation(db, observation(10_000))).toThrow(/forced daily failure/i);
    expect(db.select().from(domainObservations).all()).toEqual([]);
    expect(db.select().from(domainDailyStats).all()).toEqual([]);
  });

  it("rejects an observation whose fingerprint does not match its normalized facts", () => {
    const db = migratedDb();
    expect(() =>
      recordObservation(db, { ...observation(10_000), fingerprint: "tampered" }),
    ).toThrow(/fingerprint/i);
    expect(db.select().from(domainObservations).all()).toEqual([]);
  });

  it("defines no columns for client identity or connection payload", () => {
    const db = migratedDb();
    const columns = db.$client
      .prepare("PRAGMA table_info(domain_observations)")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(columns).toEqual([
      "fingerprint",
      "fqdn",
      "observed_at",
      "last_seen_at",
      "transport",
      "source",
      "count",
    ]);
  });
});
