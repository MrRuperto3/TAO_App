// src/app/api/portfolio/cron-status/route.ts
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { cronRuns, portfolioSnapshots } from "@/db/schema";

export async function GET() {
  try {
    const address = process.env.COLDKEY_ADDRESS;

    // Latest cron run for the snapshot job
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

    // Latest stored snapshot for the tracked address (if configured)
    const lastSnapRows = address
      ? await db
          .select({
            capturedAt: portfolioSnapshots.capturedAt,
          })
          .from(portfolioSnapshots)
          .where(eq(portfolioSnapshots.address, address))
          .orderBy(desc(portfolioSnapshots.capturedAt))
          .limit(1)
      : [];

    const lastRun = lastRunRows[0] ?? null;
    const lastSnap = lastSnapRows[0] ?? null;

    return NextResponse.json({
      ok: true,
      lastCronRun: lastRun
        ? {
            ranAt: (lastRun.ranAt as Date).toISOString(),
            ok: Boolean(lastRun.ok),
            message: lastRun.message ?? null,
            durationMs: lastRun.durationMs ?? null,
            snapshotsInserted: lastRun.snapshotsInserted ?? null,
            positionsInserted: lastRun.positionsInserted ?? null,
          }
        : null,
      lastSnapshot: lastSnap
        ? {
            capturedAt: (lastSnap.capturedAt as Date).toISOString(),
          }
        : null,
      note: address ? undefined : "COLDKEY_ADDRESS not set; snapshot lookup skipped.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
