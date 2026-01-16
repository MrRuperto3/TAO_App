import { NextResponse } from "next/server";
import { desc, eq, inArray, and, lte } from "drizzle-orm";

import { db } from "@/db";
import { portfolioSnapshots, positionSnapshots } from "@/db/schema";

type PositionType = "root" | "subnet";

type SeriesPoint = {
  capturedAt: string; // ISO
  valueTao: string;
  valueUsd: string;
  alphaBalance?: string; // subnets only
};

type PositionHistory = {
  positionType: PositionType;
  netuid: number;
  hotkey: string | null;
  name: string;
  series: SeriesPoint[];
  apy: {
    oneDayPct: string;
    sevenDayPct: string;
    thirtyDayPct: string;
  };
  flags: {
    flowLikely: boolean;
  };
};

type SubnetsApiResponse = {
  ok: boolean;
  subnets?: Array<{ netuid: number; name?: string }>;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function clampDays(raw: string | null): number {
  const n = raw ? Number(raw) : 30;
  if (!Number.isFinite(n)) return 30;
  // keep it sane; daily snapshots won't benefit from huge windows initially
  return Math.max(1, Math.min(365, Math.floor(n)));
}

function num(s: unknown): number | null {
  if (typeof s === "string" && s.trim() !== "") {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof s === "number" && Number.isFinite(s)) return s;
  return null;
}

function fmtPct(x: number): string {
  // deterministic formatting (no locale)
  return x.toFixed(2);
}

function computeApyFromSnapshots(opts: {
  startValueTao: number;
  endValueTao: number;
  days: number;
}): string {
  const { startValueTao, endValueTao, days } = opts;
  if (!(startValueTao > 0) || !(days > 0)) return "";
  const r = (endValueTao - startValueTao) / startValueTao;
  if (!Number.isFinite(r)) return "";

  // Compounded annualization
  const apy = Math.pow(1 + r, 365 / days) - 1;
  if (!Number.isFinite(apy)) return "";

  return fmtPct(apy * 100);
}

// Find the latest point at-or-before a cutoff timestamp
function findPointAtOrBefore(series: SeriesPoint[], cutoffMs: number): SeriesPoint | null {
  // series is chronological ascending
  for (let i = series.length - 1; i >= 0; i--) {
    const t = Date.parse(series[i]!.capturedAt);
    if (Number.isFinite(t) && t <= cutoffMs) return series[i]!;
  }
  return null;
}

// Heuristic: large alpha balance change likely indicates flows (stake changes/rebalances)
function isFlowLikely(series: SeriesPoint[]): boolean {
  if (series.length < 2) return false;
  const first = series[0];
  const last = series[series.length - 1];
  const a0 = first?.alphaBalance ? num(first.alphaBalance) : null;
  const a1 = last?.alphaBalance ? num(last.alphaBalance) : null;
  if (a0 === null || a1 === null || a0 <= 0) return false;

  const pct = Math.abs(a1 - a0) / a0;
  // conservative threshold; tweak later
  return pct > 0.10;
}

function getBaseUrlFromRequest(req: Request): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";

  if (!host) {
    if (process.env.NODE_ENV === "development") return "http://localhost:3000";
    throw new Error("Missing host headers for base URL resolution.");
  }

  return `${proto}://${host}`;
}

async function getSubnetNameMap(req: Request): Promise<Map<number, string>> {
  try {
    const baseUrl = getBaseUrlFromRequest(req);
    const res = await fetch(`${baseUrl}/api/subnets`, { cache: "no-store" });
    if (!res.ok) return new Map();

    const json = (await res.json()) as SubnetsApiResponse;
    const m = new Map<number, string>();

    if (json?.ok && Array.isArray(json.subnets)) {
      for (const s of json.subnets) {
        const netuid = Number((s as any)?.netuid);
        if (!Number.isFinite(netuid)) continue;

        const name = String((s as any)?.name ?? "").trim();
        if (name) m.set(netuid, name);
      }
    }

    return m;
  } catch {
    return new Map();
  }
}

export async function GET(req: Request) {
  try {
    // address is server-controlled (read-only dashboard)
    const address = requireEnv("COLDKEY_ADDRESS");

    const url = new URL(req.url);
    const days = clampDays(url.searchParams.get("days"));

    // Pull subnet names once per request (fail-soft)
    const subnetNameMap = await getSubnetNameMap(req);

    const nowMs = Date.now();
    const startMs = nowMs - days * 24 * 60 * 60 * 1000;

    // 1) Get snapshot ids within range (plus we also need "latest" for end)
    const snaps = await db
      .select({
        id: portfolioSnapshots.id,
        capturedAt: portfolioSnapshots.capturedAt,
      })
      .from(portfolioSnapshots)
      .where(
        and(eq(portfolioSnapshots.address, address), lte(portfolioSnapshots.capturedAt, new Date(nowMs)))
      )
      .orderBy(desc(portfolioSnapshots.capturedAt))
      .limit(500); // plenty for daily/hourly early on

    if (snaps.length === 0) {
      return NextResponse.json({
        ok: true,
        address,
        days,
        updatedAt: new Date().toISOString(),
        positions: [],
        note: "No snapshots yet. Wait for cron or run manual snapshot.",
      });
    }

    // Keep only snapshots >= startMs, but also keep the most recent snapshot before startMs
    const snapsSortedAsc = [...snaps].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());

    const inRange = snapsSortedAsc.filter((s) => s.capturedAt.getTime() >= startMs);
    const beforeStart = [...snapsSortedAsc].filter((s) => s.capturedAt.getTime() < startMs).slice(-1);

    const selectedSnaps = [...beforeStart, ...inRange];
    const snapshotIds = selectedSnaps.map((s) => s.id);

    if (snapshotIds.length === 0) {
      // Shouldn't happen, but fail-soft
      return NextResponse.json({
        ok: true,
        address,
        days,
        updatedAt: new Date().toISOString(),
        positions: [],
      });
    }

    // 2) Load all positions for selected snapshots
    const rows = await db
      .select({
        snapshotId: positionSnapshots.snapshotId,
        positionType: positionSnapshots.positionType,
        netuid: positionSnapshots.netuid,
        hotkey: positionSnapshots.hotkey,
        alphaBalance: positionSnapshots.alphaBalance,
        valueTao: positionSnapshots.valueTao,
        valueUsd: positionSnapshots.valueUsd,
      })
      .from(positionSnapshots)
      .where(inArray(positionSnapshots.snapshotId, snapshotIds));

    // Map snapshotId -> capturedAt ISO
    const snapTime = new Map<string, string>();
    for (const s of selectedSnaps) snapTime.set(s.id, s.capturedAt.toISOString());

    // Group by position key
    const byPos = new Map<string, PositionHistory>();

    for (const r of rows) {
      const capturedAt = snapTime.get(r.snapshotId);
      if (!capturedAt) continue;

      const positionType = r.positionType as PositionType;
      const netuid = r.netuid;
      const hotkey = r.hotkey ?? null;

      // Enforce rule: never treat netuid 0 as subnet history
      if (positionType === "subnet" && netuid === 0) continue;

      // Key (root unique; subnet unique by netuid+hotkey to be safe)
      const key = `${positionType}:${netuid}:${hotkey ?? ""}`;

      if (!byPos.has(key)) {
        const name =
          positionType === "root" ? "Root" : subnetNameMap.get(netuid) ?? `Subnet ${netuid}`;

        byPos.set(key, {
          positionType,
          netuid,
          hotkey,
          name,
          series: [],
          apy: { oneDayPct: "", sevenDayPct: "", thirtyDayPct: "" },
          flags: { flowLikely: false },
        });
      }

      const pos = byPos.get(key)!;

      pos.series.push({
        capturedAt,
        valueTao: String(r.valueTao),
        valueUsd: String(r.valueUsd),
        ...(positionType === "subnet"
          ? { alphaBalance: r.alphaBalance ? String(r.alphaBalance) : "0" }
          : {}),
      });
    }

    // Sort each series chronologically and compute APY windows
    const endCapturedAt = selectedSnaps[selectedSnaps.length - 1]!.capturedAt.toISOString();
    const endMs = Date.parse(endCapturedAt);

    const positions: PositionHistory[] = [];
    for (const pos of byPos.values()) {
      pos.series.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

      const endPoint = pos.series[pos.series.length - 1];
      const endVal = num(endPoint?.valueTao) ?? null;

      // compute windows using closest snapshot at-or-before cutoff
      const cut1 = endMs - 1 * 24 * 60 * 60 * 1000;
      const cut7 = endMs - 7 * 24 * 60 * 60 * 1000;
      const cut30 = endMs - 30 * 24 * 60 * 60 * 1000;

      const p1 = findPointAtOrBefore(pos.series, cut1);
      const p7 = findPointAtOrBefore(pos.series, cut7);
      const p30 = findPointAtOrBefore(pos.series, cut30);

      const v1 = p1 ? num(p1.valueTao) : null;
      const v7 = p7 ? num(p7.valueTao) : null;
      const v30 = p30 ? num(p30.valueTao) : null;

      if (endVal !== null && v1 !== null) {
        pos.apy.oneDayPct = computeApyFromSnapshots({
          startValueTao: v1,
          endValueTao: endVal,
          days: 1,
        });
      }

      if (endVal !== null && v7 !== null) {
        pos.apy.sevenDayPct = computeApyFromSnapshots({
          startValueTao: v7,
          endValueTao: endVal,
          days: 7,
        });
      }

      if (endVal !== null && v30 !== null) {
        pos.apy.thirtyDayPct = computeApyFromSnapshots({
          startValueTao: v30,
          endValueTao: endVal,
          days: 30,
        });
      }

      // flow heuristic (subnets only)
      pos.flags.flowLikely = pos.positionType === "subnet" ? isFlowLikely(pos.series) : false;

      positions.push(pos);
    }

    // Sort output: root first, then subnets by netuid
    positions.sort((a, b) => {
      if (a.positionType !== b.positionType) return a.positionType === "root" ? -1 : 1;
      return a.netuid - b.netuid;
    });

    return NextResponse.json({
      ok: true,
      address,
      days,
      updatedAt: new Date().toISOString(),
      endCapturedAt,
      positions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
