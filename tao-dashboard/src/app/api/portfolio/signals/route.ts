import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  portfolioSnapshots,
  positionSnapshots,
  subnetMetricSnapshots,
} from "@/db/schema";

type Severity = "INFO" | "WARN" | "CRITICAL";

type Signal = {
  id: string;
  day: string; // YYYY-MM-DD (UTC)
  netuid?: number; // missing for portfolio-level signals (not used in V1)
  severity: Severity;
  type:
    | "FLOW_SPIKE"
    | "NEGATIVE_FLOW_STREAK"
    | "EMISSION_SHOCK"
    | "LIQUIDITY_DRAIN"
    | "POSITION_VALUE_SHOCK"
    | "CONCENTRATION_RISK";
  title: string;
  why: string;
  metrics: Record<string, any>;
};

function toNum(x: unknown): number | null {
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function clampEps(x: number, eps = 1e-9): number {
  return Math.abs(x) < eps ? eps : x;
}

function meanStd(values: number[]): { mean: number; std: number } | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varPop = xs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / xs.length;
  const std = Math.sqrt(varPop);
  return { mean, std: clampEps(std) };
}

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(dayKey: string, deltaDays: number): string {
  // dayKey is YYYY-MM-DD
  const dt = new Date(`${dayKey}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return utcDayKey(dt);
}

function mkId(day: string, netuid: number | undefined, type: Signal["type"]) {
  return `${day}:${netuid ?? "portfolio"}:${type}`;
}

function sevRank(s: Severity): number {
  return s === "CRITICAL" ? 3 : s === "WARN" ? 2 : 1;
}

export async function GET() {
  const metaMissing: string[] = [];
  const signals: Signal[] = [];

  // ---------- 1) Find latest portfolio snapshot (acts as "today" reference) ----------
  const latest = await db
    .select({
      id: portfolioSnapshots.id,
      address: portfolioSnapshots.address,
      capturedAt: portfolioSnapshots.capturedAt,
      totalValueUsd: portfolioSnapshots.totalValueUsd,
    })
    .from(portfolioSnapshots)
    .orderBy(desc(portfolioSnapshots.capturedAt))
    .limit(1);

  const latestSnap = latest[0];
  if (!latestSnap) {
    return NextResponse.json({
      ok: true,
      day: null,
      signals: [],
      meta: { partial: true, missing: ["portfolio_snapshots (none found)"] },
    });
  }

  const day = utcDayKey(new Date(latestSnap.capturedAt as any));
  const prevDay = addDaysUtc(day, -1);

  // ---------- 2) Load held subnet positions for latest snapshot ----------
  const positions = await db
    .select({
      netuid: positionSnapshots.netuid,
      valueUsd: positionSnapshots.valueUsd,
      valueTao: positionSnapshots.valueTao,
      positionType: positionSnapshots.positionType,
    })
    .from(positionSnapshots)
    .where(
      and(
        eq(positionSnapshots.snapshotId, latestSnap.id),
        eq(positionSnapshots.positionType, "subnet")
      )
    );

  const heldNetuids = Array.from(
    new Set(positions.map((p) => p.netuid).filter((n) => Number.isFinite(n)))
  ).sort((a, b) => a - b);

  if (heldNetuids.length === 0) {
    return NextResponse.json({
      ok: true,
      day,
      signals: [],
      meta: {
        partial: false,
        missing: [],
        note: "No held subnet positions found in latest snapshot",
      },
    });
  }

  // ---------- 3) Fetch previous day portfolio snapshot (OPTIONAL in V1) ----------
  // Used for POSITION_VALUE_SHOCK only. If missing, we just skip that signal.
  const prevDayIso = `${prevDay}T00:00:00.000Z`;

  const prevPort = await db
    .select({
      id: portfolioSnapshots.id,
      capturedAt: portfolioSnapshots.capturedAt,
    })
    .from(portfolioSnapshots)
    .where(
      sql`date_trunc('day', ${portfolioSnapshots.capturedAt}) = date_trunc('day', ${prevDayIso}::timestamptz)`
    )
    .orderBy(desc(portfolioSnapshots.capturedAt))
    .limit(1);

  const prevPortSnap = prevPort[0] ?? null;

  // If we have it, load previous-day subnet position values (for POSITION_VALUE_SHOCK).
  let prevPositionsByNetuid = new Map<
    number,
    { valueUsd: number | null; valueTao: number | null }
  >();
  if (prevPortSnap?.id) {
    const prevPos = await db
      .select({
        netuid: positionSnapshots.netuid,
        valueUsd: positionSnapshots.valueUsd,
        valueTao: positionSnapshots.valueTao,
      })
      .from(positionSnapshots)
      .where(
        and(
          eq(positionSnapshots.snapshotId, prevPortSnap.id),
          eq(positionSnapshots.positionType, "subnet")
        )
      );

    prevPositionsByNetuid = new Map(
      prevPos.map((p) => [
        p.netuid,
        { valueUsd: toNum(p.valueUsd), valueTao: toNum(p.valueTao) },
      ])
    );
  }

  // Portfolio total USD (for concentration risk)
  const portfolioTotalUsd = toNum(latestSnap.totalValueUsd);
  if (portfolioTotalUsd == null || portfolioTotalUsd <= 0) {
    metaMissing.push("portfolio totalValueUsd (for concentration risk)");
  }

  // ---------- 4) Helper to load subnet metric rows ----------
  async function getMetricRowByDay(netuid: number, dayKey: string) {
    const row = await db
      .select({
        day: subnetMetricSnapshots.day,
        flow24h: subnetMetricSnapshots.flow24h,
        emissionPct: subnetMetricSnapshots.emissionPct,
        liquidity: subnetMetricSnapshots.liquidity,
        price: subnetMetricSnapshots.price,
        taoVolume24h: subnetMetricSnapshots.taoVolume24h,
        priceChange1d: subnetMetricSnapshots.priceChange1d,
        priceChange1w: subnetMetricSnapshots.priceChange1w,
        priceChange1m: subnetMetricSnapshots.priceChange1m,
      })
      .from(subnetMetricSnapshots)
      .where(
        and(
          eq(subnetMetricSnapshots.day, dayKey),
          eq(subnetMetricSnapshots.netuid, netuid)
        )
      )
      .limit(1);

    return row[0] ?? null;
  }

  async function getMetricHistory(
    netuid: number,
    beforeDayKey: string,
    limitDays: number
  ) {
    // day is YYYY-MM-DD text, lexical order works
    const rows = await db
      .select({
        day: subnetMetricSnapshots.day,
        flow24h: subnetMetricSnapshots.flow24h,
        emissionPct: subnetMetricSnapshots.emissionPct,
        liquidity: subnetMetricSnapshots.liquidity,
      })
      .from(subnetMetricSnapshots)
      .where(
        and(
          eq(subnetMetricSnapshots.netuid, netuid),
          sql`${subnetMetricSnapshots.day} < ${beforeDayKey}`
        )
      )
      .orderBy(desc(subnetMetricSnapshots.day))
      .limit(limitDays);

    return rows;
  }

  // ---------- 5) Generate signals per held subnet ----------
  for (const netuid of heldNetuids) {
    // Today metrics row
    const today = await getMetricRowByDay(netuid, day);
    if (!today) {
      metaMissing.push(
        `subnet_metric_snapshots missing for day=${day}, netuid=${netuid}`
      );
      continue;
    }

    // Yesterday row (optional; used for some deltas)
    const yesterday = await getMetricRowByDay(netuid, prevDay);

    // 30D history (excluding today)
    const hist30 = await getMetricHistory(netuid, day, 30);

    const flowToday = toNum(today.flow24h);
    const emisToday = toNum(today.emissionPct);
    const liqToday = toNum(today.liquidity);

    const flowHist = hist30
      .map((r) => toNum(r.flow24h))
      .filter((v): v is number => v != null);

    const emisHist = hist30
      .map((r) => toNum(r.emissionPct))
      .filter((v): v is number => v != null);

    const liqHist = hist30
      .map((r) => toNum(r.liquidity))
      .filter((v): v is number => v != null);

    // ---- A1: FLOW_SPIKE ----
    // Primary: z-score vs 30D baseline (needs history)
    // Secondary: vs yesterday pct change (needs yesterday)
    // Fallback: absolute threshold (works on day 1)
    if (flowToday != null) {
      const ms = meanStd(flowHist);
      let z: number | null = null;
      if (ms && flowHist.length >= 14) {
        z = (flowToday - ms.mean) / ms.std;
      }

      const yFlow = yesterday ? toNum(yesterday.flow24h) : null;
      const delta1 = yFlow != null ? flowToday - yFlow : null;
      const pct = yFlow != null ? delta1! / Math.max(Math.abs(yFlow), 1) : null;

      let severity: Severity | null = null;

      if (z != null) {
        const az = Math.abs(z);
        if (az >= 4) severity = "CRITICAL";
        else if (az >= 3) severity = "WARN";
        else if (az >= 2) severity = "INFO";
      } else if (pct != null) {
        const ap = Math.abs(pct);
        if (ap >= 4.0) severity = "CRITICAL";
        else if (ap >= 2.0) severity = "WARN";
        else if (ap >= 1.0) severity = "INFO";
      }

      // Absolute fallback (useful when you don't have history yet).
      // NOTE: taostats flow values are large; thresholds are intentionally large to avoid noise.
      if (!severity) {
        const af = Math.abs(flowToday);
        if (af >= 1e13) severity = "CRITICAL";
        else if (af >= 5e12) severity = "WARN";
        else if (af >= 2e12) severity = "INFO";
      }

      if (severity) {
        signals.push({
          id: mkId(day, netuid, "FLOW_SPIKE"),
          day,
          netuid,
          severity,
          type: "FLOW_SPIKE",
          title: `Flow spike detected (netuid ${netuid})`,
          why:
            z != null
              ? `24H flow deviated ${z.toFixed(2)}σ from 30D baseline.`
              : pct != null
              ? `24H flow changed sharply vs yesterday.`
              : `24H flow exceeded absolute threshold.`,
          metrics: {
            flow24h: flowToday,
            prevFlow24h: yFlow,
            delta1,
            pctChange: pct,
            z30: z,
            baselineCount: flowHist.length,
          },
        });
      }
    } else {
      metaMissing.push(`flow_24h missing (day=${day}, netuid=${netuid})`);
    }

    // ---- A3: NEGATIVE_FLOW_STREAK (3+ days warn, 7+ critical) ----
    // Works best with multiple days; harmless if you only have 1.
    if (flowToday != null) {
      const histStreak = await db
        .select({
          day: subnetMetricSnapshots.day,
          flow24h: subnetMetricSnapshots.flow24h,
        })
        .from(subnetMetricSnapshots)
        .where(
          and(
            eq(subnetMetricSnapshots.netuid, netuid),
            sql`${subnetMetricSnapshots.day} <= ${day}`
          )
        )
        .orderBy(desc(subnetMetricSnapshots.day))
        .limit(10);

      let streak = 0;
      for (const r of histStreak) {
        const f = toNum(r.flow24h);
        if (f != null && f < 0) streak++;
        else break;
      }

      let severity: Severity | null = null;
      if (streak >= 7) severity = "CRITICAL";
      else if (streak >= 3) severity = "WARN";

      if (severity) {
        signals.push({
          id: mkId(day, netuid, "NEGATIVE_FLOW_STREAK"),
          day,
          netuid,
          severity,
          type: "NEGATIVE_FLOW_STREAK",
          title: `Sustained negative flow (${streak}d) (netuid ${netuid})`,
          why: `Subnet has had net outflows for ${streak} consecutive day(s).`,
          metrics: { streakDays: streak, flow24h: flowToday },
        });
      }
    }

    // ---- B1: EMISSION_SHOCK (OPTIONAL in V1) ----
    // Taostats emission endpoint can 429. We do NOT mark the whole response partial.
    if (emisToday != null) {
      const ms = meanStd(emisHist);
      let z: number | null = null;
      if (ms && emisHist.length >= 14) {
        z = (emisToday - ms.mean) / ms.std;
      }

      const yEmis = yesterday ? toNum(yesterday.emissionPct) : null;
      const deltaPp = yEmis != null ? emisToday - yEmis : null;

      let severity: Severity | null = null;
      if (deltaPp != null) {
        const ad = Math.abs(deltaPp);
        if (ad >= 1.5) severity = "CRITICAL";
        else if (ad >= 0.75) severity = "WARN";
        else if (ad >= 0.25) severity = "INFO";
      } else if (z != null) {
        const az = Math.abs(z);
        if (az >= 4) severity = "CRITICAL";
        else if (az >= 3) severity = "WARN";
        else if (az >= 2) severity = "INFO";
      } else {
        // optional in V1
      }

      if (severity) {
        signals.push({
          id: mkId(day, netuid, "EMISSION_SHOCK"),
          day,
          netuid,
          severity,
          type: "EMISSION_SHOCK",
          title: `Emission share change (netuid ${netuid})`,
          why:
            deltaPp != null
              ? `Emission share moved ${deltaPp.toFixed(
                  4
                )} percentage points vs yesterday.`
              : `Emission share deviated strongly vs baseline.`,
          metrics: {
            emissionPct: emisToday,
            prevEmissionPct: yEmis,
            deltaPp,
            z30: z,
            baselineCount: emisHist.length,
          },
        });
      }
    } else {
      // optional in V1
    }

    // ---- C1: LIQUIDITY_DRAIN (pct drop vs yesterday OR z-score) ----
    if (liqToday != null) {
      const ms = meanStd(liqHist);
      let z: number | null = null;
      if (ms && liqHist.length >= 14) {
        z = (liqToday - ms.mean) / ms.std;
      }

      const yLiq = yesterday ? toNum(yesterday.liquidity) : null;
      const pct = yLiq != null && yLiq > 0 ? (liqToday - yLiq) / yLiq : null;

      let severity: Severity | null = null;
      if (pct != null) {
        if (pct <= -0.40) severity = "CRITICAL";
        else if (pct <= -0.25) severity = "WARN";
        else if (pct <= -0.10) severity = "INFO";
      } else if (z != null) {
        if (z <= -4) severity = "CRITICAL";
        else if (z <= -3) severity = "WARN";
        else if (z <= -2) severity = "INFO";
      }

      if (severity) {
        signals.push({
          id: mkId(day, netuid, "LIQUIDITY_DRAIN"),
          day,
          netuid,
          severity,
          type: "LIQUIDITY_DRAIN",
          title: `Liquidity dropped (netuid ${netuid})`,
          why:
            pct != null
              ? `Liquidity changed ${(pct * 100).toFixed(2)}% vs yesterday.`
              : `Liquidity is unusually low vs baseline.`,
          metrics: {
            liquidity: liqToday,
            prevLiquidity: yLiq,
            pctChange: pct,
            z30: z,
            baselineCount: liqHist.length,
          },
        });
      }
    } else {
      metaMissing.push(`liquidity missing (day=${day}, netuid=${netuid})`);
    }

    // ---- D1: POSITION_VALUE_SHOCK (OPTIONAL in V1) ----
    // Requires prev-day portfolio snapshot. If missing, we simply skip.
    const todayPos = positions.find((p) => p.netuid === netuid);
    const todayValueUsd = todayPos ? toNum(todayPos.valueUsd) : null;
    const prevPos = prevPositionsByNetuid.get(netuid);
    const prevValueUsd = prevPos?.valueUsd ?? null;

    if (todayValueUsd != null && prevValueUsd != null && prevValueUsd > 0) {
      const pct = (todayValueUsd - prevValueUsd) / prevValueUsd;

      let severity: Severity | null = null;
      const ap = Math.abs(pct);
      if (ap >= 0.20) severity = "CRITICAL";
      else if (ap >= 0.10) severity = "WARN";
      else if (ap >= 0.05) severity = "INFO";

      if (severity) {
        signals.push({
          id: mkId(day, netuid, "POSITION_VALUE_SHOCK"),
          day,
          netuid,
          severity,
          type: "POSITION_VALUE_SHOCK",
          title: `Your position value moved ${(pct * 100).toFixed(
            1
          )}% (netuid ${netuid})`,
          why: `Your subnet position value changed ${(pct * 100).toFixed(
            2
          )}% vs yesterday.`,
          metrics: {
            valueUsd: todayValueUsd,
            prevValueUsd,
            pctChange: pct,
          },
        });
      }
    }

    // ---- D4: CONCENTRATION_RISK (weight of this subnet vs portfolio total) ----
    if (
      portfolioTotalUsd != null &&
      portfolioTotalUsd > 0 &&
      todayValueUsd != null
    ) {
      const w = todayValueUsd / portfolioTotalUsd;

      let severity: Severity | null = null;
      if (w >= 0.35) severity = "CRITICAL";
      else if (w >= 0.25) severity = "WARN";
      else if (w >= 0.15) severity = "INFO";

      if (severity) {
        signals.push({
          id: mkId(day, netuid, "CONCENTRATION_RISK"),
          day,
          netuid,
          severity,
          type: "CONCENTRATION_RISK",
          title: `Concentration risk: ${(w * 100).toFixed(
            1
          )}% of portfolio (netuid ${netuid})`,
          why: `This subnet is ${(w * 100).toFixed(
            2
          )}% of your portfolio value.`,
          metrics: {
            weight: w,
            valueUsd: todayValueUsd,
            portfolioTotalUsd,
          },
        });
      }
    }
  }

  // Sort by severity desc, then netuid asc
  signals.sort((a, b) => {
    const s = sevRank(b.severity) - sevRank(a.severity);
    if (s !== 0) return s;
    const an = a.netuid ?? 0;
    const bn = b.netuid ?? 0;
    return an - bn;
  });

  return NextResponse.json({
    ok: true,
    day,
    signals,
    meta: {
      partial: metaMissing.length > 0,
      missing: Array.from(new Set(metaMissing)),
      heldNetuids,
      note: prevPortSnap?.id
        ? undefined
        : "Prev-day portfolio snapshot missing: value-shock signals are skipped in V1.",
    },
  });
}
