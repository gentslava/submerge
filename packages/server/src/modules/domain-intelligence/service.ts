import { and, eq, gte, lt, lte, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { domainDailyStats, domainObservations } from "../../db/schema.js";
import {
  canReconcileObservations,
  type DomainObservation,
  fingerprintObservation,
  normalizeObservedFqdn,
  OBSERVATION_RECONCILIATION_WINDOW_MS,
} from "./observer.js";

export interface RecordObservationResult {
  status: "inserted" | "duplicate" | "reconciled";
  dailyCount: number;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function assertObservation(observation: DomainObservation): void {
  if (normalizeObservedFqdn(observation.fqdn) !== observation.fqdn) {
    throw new Error("domain observation FQDN is not normalized");
  }
  if (
    fingerprintObservation(observation.fqdn, observation.transport, observation.observedAt) !==
    observation.fingerprint
  ) {
    throw new Error("domain observation fingerprint does not match its facts");
  }
}

export function recordObservation(db: Db, observation: DomainObservation): RecordObservationResult {
  assertObservation(observation);

  return db.transaction((tx) => {
    const day = utcDay(observation.observedAt);
    const readDailyCount = (canonicalDay: string): number =>
      tx
        .select({ count: domainDailyStats.connectionCount })
        .from(domainDailyStats)
        .where(
          and(eq(domainDailyStats.day, canonicalDay), eq(domainDailyStats.fqdn, observation.fqdn)),
        )
        .get()?.count ?? 0;

    const touchDailyAggregate = (canonicalDay: string, observedAt: number): void => {
      tx.update(domainDailyStats)
        .set({
          firstSeenAt: sql`min(${domainDailyStats.firstSeenAt}, ${observedAt})`,
          lastSeenAt: sql`max(${domainDailyStats.lastSeenAt}, ${observedAt})`,
        })
        .where(
          and(eq(domainDailyStats.day, canonicalDay), eq(domainDailyStats.fqdn, observation.fqdn)),
        )
        .run();
    };

    const rebuildDailyAggregate = (canonicalDay: string): void => {
      const dayStart = Date.parse(`${canonicalDay}T00:00:00.000Z`);
      const dayEnd = dayStart + 86_400_000;
      const rows = tx
        .select()
        .from(domainObservations)
        .where(
          and(
            eq(domainObservations.fqdn, observation.fqdn),
            gte(domainObservations.observedAt, dayStart),
            lt(domainObservations.observedAt, dayEnd),
          ),
        )
        .all();
      if (rows.length === 0) {
        tx.delete(domainDailyStats)
          .where(
            and(
              eq(domainDailyStats.day, canonicalDay),
              eq(domainDailyStats.fqdn, observation.fqdn),
            ),
          )
          .run();
        return;
      }

      const connectionCount = rows.reduce((total, row) => total + row.count, 0);
      const firstSeenAt = Math.min(...rows.map((row) => row.observedAt));
      const lastSeenAt = Math.max(...rows.map((row) => row.lastSeenAt));
      tx.insert(domainDailyStats)
        .values({
          day: canonicalDay,
          fqdn: observation.fqdn,
          connectionCount,
          firstSeenAt,
          lastSeenAt,
        })
        .onConflictDoUpdate({
          target: [domainDailyStats.day, domainDailyStats.fqdn],
          set: { connectionCount, firstSeenAt, lastSeenAt },
        })
        .run();
    };

    const reconcileStored = (
      stored: typeof domainObservations.$inferSelect,
      status: "duplicate" | "reconciled",
    ): RecordObservationResult => {
      const incomingIsCanonical =
        observation.observedAt < stored.observedAt ||
        (observation.observedAt === stored.observedAt &&
          observation.source === "connection-snapshot" &&
          stored.source !== "connection-snapshot");
      const previousDay = utcDay(stored.observedAt);
      const canonicalDay = utcDay(incomingIsCanonical ? observation.observedAt : stored.observedAt);
      tx.update(domainObservations)
        .set({
          fingerprint: incomingIsCanonical ? observation.fingerprint : stored.fingerprint,
          observedAt: incomingIsCanonical ? observation.observedAt : stored.observedAt,
          source: incomingIsCanonical ? observation.source : stored.source,
          lastSeenAt: Math.max(stored.lastSeenAt, observation.observedAt),
        })
        .where(eq(domainObservations.fingerprint, stored.fingerprint))
        .run();

      if (previousDay === canonicalDay) {
        touchDailyAggregate(canonicalDay, observation.observedAt);
      } else {
        rebuildDailyAggregate(previousDay);
        rebuildDailyAggregate(canonicalDay);
      }
      return { status, dailyCount: readDailyCount(canonicalDay) };
    };

    const exact = tx
      .select()
      .from(domainObservations)
      .where(eq(domainObservations.fingerprint, observation.fingerprint))
      .get();
    if (exact) return reconcileStored(exact, "duplicate");

    const lowerBound = Math.max(0, observation.observedAt - OBSERVATION_RECONCILIATION_WINDOW_MS);
    const upperBound = observation.observedAt + OBSERVATION_RECONCILIATION_WINDOW_MS;
    const candidate = tx
      .select()
      .from(domainObservations)
      .where(
        and(
          eq(domainObservations.fqdn, observation.fqdn),
          eq(domainObservations.transport, observation.transport),
          ne(domainObservations.source, observation.source),
          gte(domainObservations.observedAt, lowerBound),
          lte(domainObservations.observedAt, upperBound),
        ),
      )
      .orderBy(sql`abs(${domainObservations.observedAt} - ${observation.observedAt})`)
      .limit(1)
      .get();
    const reconciled =
      candidate && canReconcileObservations(candidate, observation) ? candidate : undefined;
    if (reconciled) return reconcileStored(reconciled, "reconciled");

    tx.insert(domainObservations)
      .values({
        fingerprint: observation.fingerprint,
        fqdn: observation.fqdn,
        observedAt: observation.observedAt,
        lastSeenAt: observation.observedAt,
        transport: observation.transport,
        source: observation.source,
        count: 1,
      })
      .run();
    tx.insert(domainDailyStats)
      .values({
        day,
        fqdn: observation.fqdn,
        connectionCount: 1,
        firstSeenAt: observation.observedAt,
        lastSeenAt: observation.observedAt,
      })
      .onConflictDoUpdate({
        target: [domainDailyStats.day, domainDailyStats.fqdn],
        set: {
          connectionCount: sql`${domainDailyStats.connectionCount} + 1`,
          firstSeenAt: sql`min(${domainDailyStats.firstSeenAt}, ${observation.observedAt})`,
          lastSeenAt: sql`max(${domainDailyStats.lastSeenAt}, ${observation.observedAt})`,
        },
      })
      .run();
    return { status: "inserted", dailyCount: readDailyCount(day) };
  });
}
