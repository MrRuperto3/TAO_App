import { NextResponse } from "next/server";
import { and, desc, eq, gte, lte, inArray } from "drizzle-orm";

import { db } from "@/db";
import { portfolioSnapshots, positionSnapshots } from "@/db/schema";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function clampDays(raw: string | null): number {
  const n = raw ? Number(raw) : 30;
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(365, Math.floor(n)));
}

// Drizzle numeric often returns string. Treat as number for analytics.
function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function pctFrom(start: number, end: number): number | null {
  if (!(start > 0)) return null;
  const p = ((end - start) / start) * 100;
  return Number.isFinite(p) ? p : null;
}

/**
 * Heuristic: detect "flow-like" alpha changes (buying / rebalancing) vs organic staking rewards.
 * - For daily snapshots, reward deltas are usually small relative to balance.
 * - We flag as flow when alpha grows "too much" in a single snapshot interval.
 *
 * You can tune thresholds later:
 * - alphaPctThreshold: 0.05 = 5% of starting alpha in one period
 * - valuePctThreshold: 0.10 = 10% of starting TAO value in one period
 */
function isFlowLikely(opts: {
  alphaStart: number;
  alphaEnd: number;
  valueTaoStart: number;
  valueTaoEnd: number;
  alphaPctThreshold?: number;
  valuePctThreshold?: number;
}): boolean {
  const {
    alphaStart,
    alphaEnd,
    valueTaoStart,
    valueTaoEnd,
    alphaPctThreshold = 0.05,
    valuePctThreshold = 0.10,
  } = opts;

  const alphaDelta = alphaEnd - alphaStart;
  const valueDelta = valueTaoEnd - valueTaoStart;

  // If we're decreasing, we treat it as not "buying" (could be redelegation/unstake).
  // We'll allow negatives to flow through the staking-est series as a "loss" signal.
  if (!(alphaDelta > 0)) return false;

  // If we had no starting alpha, a positive jump is almost certainly a deposit/purchase.
  if (!(alphaStart > 0)) return true;

  const alphaPct = Math.abs(alphaDelta) / alphaStart;
  if (Number.isFinite(alphaPct) && alphaPct > alphaPctThreshold) return true;

  // Optional value jump check helps catch cases where alpha changed a lot in TAO terms
  // even if alphaStart is small.
  if (valueTaoStart > 0) {
    const valuePct = Math.abs(valueDelta) / valueTaoStart;
    if (Number.isFinite(valuePct) && valuePct > valuePctThreshold) return true;
  }

  return false;
}

type Contributor = {
  netuid: number;
  hotkey: string | null;

  alphaEarnedNet: string; // net token delta across range
  alphaEarnedStakingEst: string; // filtered token delta across range

  taoImpactEstNet: string; // net (alpha delta * end price) summed
  taoImpactEstStaking: string; // filtered impact summed

  sharePctNet: string; // share of net impact
  sharePctStaking: string; // share of staking-est impact

  flowLikelyPeriods: number; // how many intervals were excluded as "flow-like"
};

export async function GET(req: Request) {
  try {
    const address = requireEnv("COLDKEY_ADDRESS");

    const url = new URL(req.url);
    const days = clampDays(url.searchParams.get("days"));

    const nowMs = Date.now();
    const startMs = nowMs - days * 24 * 60 * 60 * 1000;

    const snapsDesc = await db
      .select({
        id: portfolioSnapshots.id,
        capturedAt: portfolioSnapshots.capturedAt,
        taoUsd: portfolioSnapshots.taoUsd,
        totalValueTao: portfolioSnapshots.totalValueTao,
        totalValueUsd: portfolioSnapshots.totalValueUsd,
      })
      .from(portfolioSnapshots)
      .where(and(eq(portfolioSnapshots.address, address), lte(portfolioSnapshots.capturedAt, new Date(nowMs))))
      .orderBy(desc(portfolioSnapshots.capturedAt))
      .limit(800);

    if (snapsDesc.length < 2) {
      return NextResponse.json({
        ok: true,
        address,
        days,
        updatedAt: new Date().toISOString(),
        note: "Not enough snapshots yet (need at least 2).",
        kpis: null,
        contributors: [],
        daily: [],
      });
    }

    const snapsAsc = [...snapsDesc].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());

    const inRange = snapsAsc.filter((s) => s.capturedAt.getTime() >= startMs);
    const beforeStart = snapsAsc.filter((s) => s.capturedAt.getTime() < startMs).slice(-1);

    const selected = [...beforeStart, ...inRange];
    if (selected.length < 2) {
      return NextResponse.json({
        ok: true,
        address,
        days,
        updatedAt: new Date().toISOString(),
        note: "Not enough snapshots in selected range.",
        kpis: null,
        contributors: [],
        daily: [],
      });
    }

    const startSnap = selected[0]!;
    const endSnap = selected[selected.length - 1]!;
    const endCapturedAt = endSnap.capturedAt.toISOString();

    const startTotalTao = num(startSnap.totalValueTao);
    const endTotalTao = num(endSnap.totalValueTao);

    const startTotalUsd = num(startSnap.totalValueUsd);
    const endTotalUsd = num(endSnap.totalValueUsd);

    const returnTaoPct = pctFrom(startTotalTao, endTotalTao);
    const returnUsdPct = pctFrom(startTotalUsd, endTotalUsd);

    const deltaTao = endTotalTao - startTotalTao;
    const deltaUsd = endTotalUsd - startTotalUsd;

    // Max drawdown (TAO)
    let peak = -Infinity;
    let maxDrawdownPct: number | null = null;
    for (const s of selected) {
      const v = num(s.totalValueTao);
      if (!Number.isFinite(v)) continue;
      if (v > peak) peak = v;
      if (peak > 0) {
        const dd = (v / peak - 1) * 100;
        if (maxDrawdownPct === null || dd < maxDrawdownPct) maxDrawdownPct = dd;
      }
    }

    // --- Contributors: need subnet position snapshots for all selected snapshot IDs.
    const snapshotIds = selected.map((s) => s.id);

    const posRows = await db
      .select({
        snapshotId: positionSnapshots.snapshotId,
        netuid: positionSnapshots.netuid,
        hotkey: positionSnapshots.hotkey,
        alphaBalance: positionSnapshots.alphaBalance,
        valueTao: positionSnapshots.valueTao,
      })
      .from(positionSnapshots)
      .where(and(inArray(positionSnapshots.snapshotId, snapshotIds), eq(positionSnapshots.positionType, "subnet")));

    // snapshotId -> key -> state
    type PosState = { netuid: number; hotkey: string | null; alpha: number; valueTao: number; priceTao: number };
    const bySnap = new Map<string, Map<string, PosState>>();

    for (const r of posRows) {
      const sid = String(r.snapshotId);
      const netuid = Number(r.netuid);
      if (!Number.isFinite(netuid) || netuid === 0) continue;

      const hotkey = r.hotkey ? String(r.hotkey) : null;
      const alpha = num(r.alphaBalance);
      const valueTao = num(r.valueTao);
      const priceTao = alpha > 0 && valueTao > 0 ? valueTao / alpha : 0;

      const key = `${netuid}:${hotkey ?? ""}`;

      if (!bySnap.has(sid)) bySnap.set(sid, new Map());
      bySnap.get(sid)!.set(key, { netuid, hotkey, alpha, valueTao, priceTao });
    }

    // Aggregate net + staking-est values
    const alphaNetByKey = new Map<string, number>();
    const alphaStakingByKey = new Map<string, number>();

    const taoNetByKey = new Map<string, number>();
    const taoStakingByKey = new Map<string, number>();

    const flowLikelyCountByKey = new Map<string, number>();

    for (let i = 0; i < selected.length - 1; i++) {
      const start = selected[i]!;
      const end = selected[i + 1]!;

      const startMap = bySnap.get(String(start.id)) ?? new Map();
      const endMap = bySnap.get(String(end.id)) ?? new Map();

      const keys = new Set<string>([...startMap.keys(), ...endMap.keys()]);

      for (const k of keys) {
        const s0 = startMap.get(k);
        const s1 = endMap.get(k);

        const alphaStart = s0?.alpha ?? 0;
        const alphaEnd = s1?.alpha ?? 0;
        const earned = alphaEnd - alphaStart;

        if (!Number.isFinite(earned) || earned === 0) continue;

        // END snapshot price for impact estimate
        const endPrice = s1?.priceTao ?? 0;
        const taoImpact = endPrice > 0 ? earned * endPrice : 0;

        // Net aggregation
        alphaNetByKey.set(k, (alphaNetByKey.get(k) ?? 0) + earned);
        taoNetByKey.set(k, (taoNetByKey.get(k) ?? 0) + taoImpact);

        // Flow filter for staking-est aggregation
        const flowLikely = isFlowLikely({
          alphaStart,
          alphaEnd,
          valueTaoStart: s0?.valueTao ?? 0,
          valueTaoEnd: s1?.valueTao ?? 0,
        });

        if (flowLikely) {
          flowLikelyCountByKey.set(k, (flowLikelyCountByKey.get(k) ?? 0) + 1);
          // Exclude positive "buy-like" spikes from staking-est
          continue;
        }

        alphaStakingByKey.set(k, (alphaStakingByKey.get(k) ?? 0) + earned);
        taoStakingByKey.set(k, (taoStakingByKey.get(k) ?? 0) + taoImpact);
      }
    }

    const totalImpactNet = [...taoNetByKey.values()].reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
    const totalImpactStaking = [...taoStakingByKey.values()].reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);

    const contributors: Contributor[] = [];
    const allKeys = new Set<string>([...alphaNetByKey.keys(), ...alphaStakingByKey.keys()]);

    for (const k of allKeys) {
      const [netuidStr, hotkeyStr] = k.split(":");
      const netuid = Number(netuidStr);
      const hotkey = hotkeyStr ? hotkeyStr : null;

      const alphaNet = alphaNetByKey.get(k) ?? 0;
      const alphaStake = alphaStakingByKey.get(k) ?? 0;

      const taoNet = taoNetByKey.get(k) ?? 0;
      const taoStake = taoStakingByKey.get(k) ?? 0;

      const shareNet = totalImpactNet > 0 ? (taoNet / totalImpactNet) * 100 : 0;
      const shareStake = totalImpactStaking > 0 ? (taoStake / totalImpactStaking) * 100 : 0;

      contributors.push({
        netuid,
        hotkey,
        alphaEarnedNet: String(alphaNet),
        alphaEarnedStakingEst: String(alphaStake),
        taoImpactEstNet: String(taoNet),
        taoImpactEstStaking: String(taoStake),
        sharePctNet: String(shareNet),
        sharePctStaking: String(shareStake),
        flowLikelyPeriods: flowLikelyCountByKey.get(k) ?? 0,
      });
    }

    // Sort by staking impact first (what user wants), fallback net
    contributors.sort((a, b) => num(b.taoImpactEstStaking) - num(a.taoImpactEstStaking) || num(b.taoImpactEstNet) - num(a.taoImpactEstNet));

    // --- Daily returns (last 7 deltas) from totalValueTao
    const daily = [];
    for (let i = 1; i < selected.length; i++) {
      const prev = selected[i - 1]!;
      const curr = selected[i]!;

      const prevTao = num(prev.totalValueTao);
      const currTao = num(curr.totalValueTao);

      const p = pctFrom(prevTao, currTao);

      daily.push({
        periodEnd: curr.capturedAt.toISOString(),
        deltaTao: String(currTao - prevTao),
        returnPctTao: p === null ? "" : p.toFixed(4),
      });
    }
    const dailyLast7 = daily.slice(-7).reverse();

    const alphaTaoImpactEstNet = totalImpactNet;
    const alphaTaoImpactEstStaking = totalImpactStaking;

    return NextResponse.json({
      ok: true,
      address,
      days,
      updatedAt: new Date().toISOString(),
      endCapturedAt,

      kpis: {
        startTotalTao: String(startTotalTao),
        endTotalTao: String(endTotalTao),
        deltaTao: String(deltaTao),
        returnTaoPct: returnTaoPct === null ? "" : returnTaoPct.toFixed(4),

        startTotalUsd: String(startTotalUsd),
        endTotalUsd: String(endTotalUsd),
        deltaUsd: String(deltaUsd),
        returnUsdPct: returnUsdPct === null ? "" : returnUsdPct.toFixed(4),

        // Keep both so UI can choose.
        alphaTaoImpactEstNet: String(alphaTaoImpactEstNet),
        alphaTaoImpactEstStaking: String(alphaTaoImpactEstStaking),

        maxDrawdownPct: maxDrawdownPct === null ? "" : maxDrawdownPct.toFixed(4),
      },

      contributors,
      daily: dailyLast7,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
