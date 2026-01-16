import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { db } from "@/db/index";
import { portfolioSnapshots, positionSnapshots } from "@/db/schema";

type AlphaDeltaPeriod = {
  periodStart: string;
  periodEnd: string;
  netuid: number;
  hotkey: string | null;
  alphaStart: string; // numeric -> string
  alphaEnd: string; // numeric -> string
  alphaEarned: string; // end - start
};

function toNumStr(x: unknown): string {
  if (x == null) return "0";
  const s = String(x).trim();
  return s ? s : "0";
}

// Drizzle numeric values often come back as string.
// This is fine for dashboard delta math.
function toNumber(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    const hoursRaw = Number(url.searchParams.get("hours") ?? "48");
    const hours = Math.max(2, Math.min(24 * 30, Number.isFinite(hoursRaw) ? hoursRaw : 48)); // clamp: 2..720

    const address = process.env.COLDKEY_ADDRESS;
    if (!address) {
      return NextResponse.json({ ok: false, error: "Missing COLDKEY_ADDRESS env var." }, { status: 500 });
    }

    const now = new Date();
    const since = new Date(now.getTime() - hours * 60 * 60 * 1000);

    // 1) Snapshots for this address, newest -> oldest
    const snaps = await db
      .select({
        id: portfolioSnapshots.id,
        capturedAt: portfolioSnapshots.capturedAt,
      })
      .from(portfolioSnapshots)
      .where(and(eq(portfolioSnapshots.address, address), gte(portfolioSnapshots.capturedAt, since)))
      .orderBy(desc(portfolioSnapshots.capturedAt));

    if (snaps.length < 2) {
      return NextResponse.json({ ok: true, hours, periods: [] satisfies AlphaDeltaPeriod[] });
    }

    const snapshotIds = snaps.map((s) => s.id);

    // 2) Subnet position snapshots for those snapshots
    const rows = await db
      .select({
        snapshotId: positionSnapshots.snapshotId,
        netuid: positionSnapshots.netuid,
        hotkey: positionSnapshots.hotkey,
        alphaBalance: positionSnapshots.alphaBalance,
      })
      .from(positionSnapshots)
      .where(and(inArray(positionSnapshots.snapshotId, snapshotIds), eq(positionSnapshots.positionType, "subnet")));

    // snapshotId -> capturedAt
    const snapTimeById = new Map<string, Date>();
    for (const s of snaps) {
      snapTimeById.set(String(s.id), new Date(s.capturedAt));
    }

    // snapshotId -> key(netuid:hotkey) -> alpha
    const posBySnapshot = new Map<
      string,
      Map<string, { netuid: number; hotkey: string | null; alpha: number; alphaStr: string }>
    >();

    for (const r of rows) {
      const snapshotId = String(r.snapshotId);
      const netuid = Number(r.netuid);
      if (!Number.isFinite(netuid)) continue;

      const hotkey = r.hotkey ? String(r.hotkey) : null;

      const alphaStr = toNumStr(r.alphaBalance);
      const alpha = toNumber(alphaStr);

      const key = `${netuid}:${hotkey ?? ""}`;

      if (!posBySnapshot.has(snapshotId)) posBySnapshot.set(snapshotId, new Map());
      posBySnapshot.get(snapshotId)!.set(key, { netuid, hotkey, alpha, alphaStr });
    }

    // snaps are newest -> oldest.
    // For consecutive snapshot periods: start = [i+1], end = [i]
    const periods: AlphaDeltaPeriod[] = [];

    for (let i = 0; i < snaps.length - 1; i++) {
      const endSnap = snaps[i];
      const startSnap = snaps[i + 1];

      const endId = String(endSnap.id);
      const startId = String(startSnap.id);

      const endAt = snapTimeById.get(endId);
      const startAt = snapTimeById.get(startId);
      if (!endAt || !startAt) continue;

      const endMap = posBySnapshot.get(endId) ?? new Map();
      const startMap = posBySnapshot.get(startId) ?? new Map();

      const keys = new Set<string>([...endMap.keys(), ...startMap.keys()]);

      for (const k of keys) {
        const endPos = endMap.get(k);
        const startPos = startMap.get(k);

        const netuid = endPos?.netuid ?? startPos?.netuid;
        if (netuid == null) continue;

        const hotkey = endPos?.hotkey ?? startPos?.hotkey ?? null;

        const alphaEndStr = endPos?.alphaStr ?? "0";
        const alphaStartStr = startPos?.alphaStr ?? "0";

        const alphaEnd = endPos?.alpha ?? toNumber(alphaEndStr);
        const alphaStart = startPos?.alpha ?? toNumber(alphaStartStr);

        const alphaEarned = alphaEnd - alphaStart;

        periods.push({
          periodStart: startAt.toISOString(),
          periodEnd: endAt.toISOString(),
          netuid,
          hotkey,
          alphaStart: alphaStartStr,
          alphaEnd: alphaEndStr,
          alphaEarned: String(alphaEarned),
        });
      }
    }

    // Newest periods first
    periods.sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0));

    return NextResponse.json({ ok: true, hours, periods });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Unknown error computing alpha deltas." },
      { status: 500 }
    );
  }
}
