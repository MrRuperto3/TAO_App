import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { portfolioSnapshots, positionSnapshots } from "@/db/schema";

// ---- Types (match your /api/portfolio JSON shape) ----
type PortfolioResponse = {
  ok: boolean;
  updatedAt: string; // ISO
  address: string;
  pricing: { taoUsd: string; source: string };
  root: {
    netuid: 0;
    valueTao: string;
    valueUsd: string;
  };
  subnets: Array<{
    netuid: number;
    name: string;
    alphaBalance: string;
    alphaPriceTao: string;
    valueTao: string;
    valueUsd: string;
    hotkey: string;
  }>;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Safely coerce numeric-ish strings to something DB numeric accepts.
// Drizzle numeric columns accept strings; we keep precision by not parsing to JS number.
function toNumericString(value: unknown, fallback = "0"): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

// Basic UTC day boundaries using SQL date_trunc for idempotency.
// We treat "one snapshot per UTC day per address".
async function snapshotExistsForUtcDay(address: string, capturedAtIso: string): Promise<boolean> {
  const [row] = await db
    .select({ id: portfolioSnapshots.id })
    .from(portfolioSnapshots)
    .where(
      and(
        eq(portfolioSnapshots.address, address),
        sql`date_trunc('day', ${portfolioSnapshots.capturedAt}) = date_trunc('day', ${capturedAtIso}::timestamptz)`
      )
    )
    .limit(1);

  return Boolean(row?.id);
}

export async function POST(req: Request) {
  try {
    // ---- Security gate ----
    const cronSecret = requireEnv("CRON_SECRET");
    const provided = req.headers.get("x-cron-secret");
    if (!provided || provided !== cronSecret) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    // ---- Build absolute URL to /api/portfolio (works locally + on Vercel) ----
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    if (!host) {
      return NextResponse.json({ ok: false, error: "Missing host header" }, { status: 400 });
    }
    const baseUrl = `${proto}://${host}`;

    // ---- Fetch portfolio snapshot from your existing BFF ----
    const res = await fetch(`${baseUrl}/api/portfolio`, {
      method: "GET",
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Portfolio fetch failed: ${res.status}` },
        { status: 502 }
      );
    }

    const data = (await res.json()) as PortfolioResponse;

    if (!data?.ok) {
      return NextResponse.json({ ok: false, error: "Portfolio returned ok=false" }, { status: 502 });
    }

    // ---- Idempotency: one per UTC day per address ----
    const capturedAtIso = data.updatedAt;
    const address = data.address;

    const already = await snapshotExistsForUtcDay(address, capturedAtIso);
    if (already) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "snapshot already exists for UTC day",
        address,
        capturedAt: capturedAtIso,
      });
    }

    // ---- Insert portfolio_snapshots ----
    const taoUsd = toNumericString(data.pricing?.taoUsd, "0");
    const pricingSource = typeof data.pricing?.source === "string" ? data.pricing.source : "unknown";

    const [snap] = await db
      .insert(portfolioSnapshots)
      .values({
        capturedAt: new Date(capturedAtIso),
        address,
        taoUsd,
        pricingSource,
        raw: data, // stored as jsonb
      })
      .returning({ id: portfolioSnapshots.id });

    if (!snap?.id) {
      return NextResponse.json({ ok: false, error: "Failed to create snapshot" }, { status: 500 });
    }

    // ---- Insert positions (Root separate; Subnets exclude netuid 0) ----
    const positionRows: Array<typeof positionSnapshots.$inferInsert> = [];

    // Root (from data.root only)
    positionRows.push({
      snapshotId: snap.id,
      positionType: "root",
      netuid: 0,
      hotkey: null,
      alphaBalance: null,
      valueTao: toNumericString(data.root?.valueTao, "0"),
      valueUsd: toNumericString(data.root?.valueUsd, "0"),
    });

    // Subnets (exclude netuid 0 to honor Root separation rule)
    for (const s of Array.isArray(data.subnets) ? data.subnets : []) {
      if (s.netuid === 0) continue;

      positionRows.push({
        snapshotId: snap.id,
        positionType: "subnet",
        netuid: s.netuid,
        hotkey: typeof s.hotkey === "string" ? s.hotkey : null,
        alphaBalance: toNumericString(s.alphaBalance, "0"),
        valueTao: toNumericString(s.valueTao, "0"),
        valueUsd: toNumericString(s.valueUsd, "0"),
      });
    }

    if (positionRows.length > 0) {
      await db.insert(positionSnapshots).values(positionRows);
    }

    return NextResponse.json({
      ok: true,
      skipped: false,
      address,
      capturedAt: capturedAtIso,
      snapshotId: snap.id,
      positionsInserted: positionRows.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
