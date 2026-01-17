import { NextResponse } from "next/server";
import { and, desc, eq, gte } from "drizzle-orm";

import { db } from "@/db";
import { cronRuns, portfolioSnapshots } from "@/db/schema";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function toIso(d: Date) {
  return d.toISOString();
}

// Build a UTC date key like "2026-01-17"
function utcDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Return array of last N UTC day keys, oldest -> newest
function lastNUtcDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  // normalize to UTC date boundary by using UTC components
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 24 * 60 * 60 * 1000);
    out.push(utcDayKey(d));
  }
  return out;
}

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / (24 * 60 * 60 * 1000);
}

export async function GET() {
  try {
    const address = requireEnv("COLDKEY_ADDRESS");

    const now = new Date();
    const expectedCadence = "daily";

    // Pull recent snapshots (enough for last 35 days)
    const windowDays = 35;
    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const snaps = await db
      .select({
        capturedAt: portfolioSnapshots.capturedAt,
      })
      .from(portfolioSnapshots)
      .where(and(eq(portfolioSnapshots.address, address), gte(portfolioSnapshots.capturedAt, since)))
      .orderBy(desc(portfolioSnapshots.capturedAt))
      .limit(2000);

    const lastSnapshotAt = snaps[0]?.capturedAt ?? null;

    // Compute presence per UTC day for last 30 days
    const expectedDays = 30;
    const expectedKeys = lastNUtcDays(expectedDays);
    const present = new Set<string>();

    for (const s of snaps) {
      present.add(utcDayKey(s.capturedAt));
    }

    const missingKeys = expectedKeys.filter((k) => !present.has(k));
    const presentCount = expectedDays - missingKeys.length;

    // Streak: count consecutive days (from today backwards) that have a snapshot
    let streakDays = 0;
    for (let i = expectedKeys.length - 1; i >= 0; i--) {
      const k = expectedKeys[i]!;
      if (present.has(k)) streakDays++;
      else break;
    }

    const ageDays = lastSnapshotAt ? daysBetween(now, lastSnapshotAt) : null;
    // Daily snapshots: flag stale if older than ~1.75 days (DST-safe buffer)
    const snapshotStale = ageDays !== null ? ageDays > 1.75 : true;

    // Last cron run record (from cron_runs)
    const lastRunRows = await db
      .select({
        ranAt: cronRuns.ranAt,
        ok: cronRuns.ok,
        message: cronRuns.message,
        durationMs: cronRuns.durationMs,
        snapshotsInserted: cronRuns.snapshotsInserted,
        positionsInserted: cronRuns.positionsInserted,
      })
      .from(cronRuns)
      .where(eq(cronRuns.job, "snapshot"))
      .orderBy(desc(cronRuns.ranAt))
      .limit(1);

    const lastCronRun = lastRunRows[0] ?? null;

    return NextResponse.json({
      ok: true,
      address,
      expectedCadence,
      now: toIso(now),

      lastSnapshotAt: lastSnapshotAt ? toIso(lastSnapshotAt) : null,
      snapshotAgeDays: ageDays !== null ? Number(ageDays.toFixed(2)) : null,
      snapshotStale,

      coverageLast30: {
        expected: expectedDays,
        present: presentCount,
        missing: missingKeys.length,
      },

      // Cap missing list so payload stays small
      missingDatesUtc: missingKeys.slice(-14),

      streakDays,

      lastCronRun: lastCronRun
        ? {
            ranAt: toIso(lastCronRun.ranAt),
            ok: lastCronRun.ok,
            message: lastCronRun.message ?? null,
            durationMs: lastCronRun.durationMs ?? null,
            snapshotsInserted: lastCronRun.snapshotsInserted ?? null,
            positionsInserted: lastCronRun.positionsInserted ?? null,
          }
        : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
