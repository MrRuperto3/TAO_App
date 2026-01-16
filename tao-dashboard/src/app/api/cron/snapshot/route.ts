import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { portfolioSnapshots, positionSnapshots } from "@/db/schema";

type PortfolioResponse = {
  ok: boolean;
  updatedAt: string;
  address: string;

  pricing?: {
    taoUsd: string;
    source: string;
  };

  tao: { free: string; staked: string; total: string };

  root?:
    | {
        netuid: 0;
        valueTao: string;
        valueUsd: string;
      }
    | null;

  subnets: Array<{
    netuid: number;
    name?: string;
    alphaBalance: string;
    alphaPriceTao?: string;
    valueTao: string;
    valueUsd?: string;
    hotkey?: string;
  }>;

  totals: {
    totalValueTao: string;
    totalValueUsd?: string;
    subnetValueTao: string;
    taoValueTao: string;
  };

  error?: string;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getAuthSecret(req: Request): string | null {
  // Vercel cron: Authorization: Bearer <CRON_SECRET> :contentReference[oaicite:2]{index=2}
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }

  // Manual curl convenience
  const x = req.headers.get("x-cron-secret");
  if (x && x.trim()) return x.trim();

  return null;
}

function getBaseUrlFromRequest(req: Request): string {
  const host =
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host");

  const proto =
    req.headers.get("x-forwarded-proto") ??
    "https";

  if (!host) {
    if (process.env.NODE_ENV === "development") {
      return "http://localhost:3000";
    }
    throw new Error("Missing host headers for base URL resolution");
  }

  return `${proto}://${host}`;
}

function toStr(x: unknown): string {
  return typeof x === "string" ? x : x == null ? "" : String(x);
}

function toNetuid(x: unknown): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function snapshotExistsForUtcHour(opts: {
  address: string;
  capturedAt: Date;
}): Promise<boolean> {
  const { address, capturedAt } = opts;

  // Compare hour buckets in UTC.
  // date_trunc('hour', timestamptz) works as UTC with timestamptz inputs.
  const rows = await db
    .select({ id: portfolioSnapshots.id })
    .from(portfolioSnapshots)
    .where(
      and(
        eq(portfolioSnapshots.address, address),
        sql`date_trunc('hour', ${portfolioSnapshots.capturedAt}) = date_trunc('hour', ${capturedAt.toISOString()}::timestamptz)`
      )
    )
    .limit(1);

  return rows.length > 0;
}

async function takeSnapshot(req: Request) {
  const address = requireEnv("COLDKEY_ADDRESS");

  const capturedAt = new Date();

  // hourly idempotency
  const exists = await snapshotExistsForUtcHour({ address, capturedAt });
  if (exists) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "snapshot already exists for UTC hour",
      address,
      capturedAt: capturedAt.toISOString(),
    });
  }

  // Fetch normalized portfolio data from your existing BFF
  const baseUrl = getBaseUrlFromRequest(req);

  await fetch(`${baseUrl}/api/whatever`, {
    cache: "no-store",
  });
  const portfolioRes = await fetch(`${baseUrl}/api/portfolio`, { cache: "no-store" });
  const portfolioJson = (await portfolioRes.json()) as PortfolioResponse;

  if (!portfolioJson?.ok) {
    return NextResponse.json(
      { ok: false, error: portfolioJson?.error ?? "Failed to fetch /api/portfolio" },
      { status: 502 }
    );
  }

  // Use totals + pricing from the payload (strings)
  const taoUsd = toStr(portfolioJson?.pricing?.taoUsd);
  const totalValueTao = toStr(portfolioJson?.totals?.totalValueTao);
  const totalValueUsd = toStr(portfolioJson?.totals?.totalValueUsd);

  // Insert portfolio snapshot
  const inserted = await db
    .insert(portfolioSnapshots)
    .values({
      address,
      capturedAt,
      taoUsd,
      totalValueTao,
      totalValueUsd,
    })
    .returning({ id: portfolioSnapshots.id });

  const snapshotId = inserted[0]?.id;
  if (!snapshotId) {
    return NextResponse.json({ ok: false, error: "Failed to insert portfolio snapshot" }, { status: 500 });
  }

  // Root position: prefer dedicated root object; fallback to netuid 0 in subnets array
  const rootFromRoot = portfolioJson.root ?? null;
  const rootFromSubnets = portfolioJson.subnets?.find((s) => s.netuid === 0) ?? null;

  const rootValueTao = toStr(rootFromRoot?.valueTao ?? rootFromSubnets?.valueTao ?? "0");
  const rootValueUsd = toStr(rootFromRoot?.valueUsd ?? rootFromSubnets?.valueUsd ?? "0");

  const positionRows: Array<{
    snapshotId: string;
    positionType: "root" | "subnet";
    netuid: number;
    hotkey: string | null;
    alphaBalance: string | null;
    valueTao: string;
    valueUsd: string;
  }> = [];

  // Always write root row
  positionRows.push({
    snapshotId,
    positionType: "root",
    netuid: 0,
    hotkey: null,
    alphaBalance: null,
    valueTao: rootValueTao,
    valueUsd: rootValueUsd,
  });

  // Subnet rows (exclude netuid 0)
  for (const s of portfolioJson.subnets ?? []) {
    const netuid = toNetuid((s as any)?.netuid);
    if (netuid == null) continue;
    if (netuid === 0) continue;

    positionRows.push({
      snapshotId,
      positionType: "subnet",
      netuid,
      hotkey: toStr((s as any)?.hotkey || "") || null,
      alphaBalance: toStr((s as any)?.alphaBalance || "0"),
      valueTao: toStr((s as any)?.valueTao || "0"),
      valueUsd: toStr((s as any)?.valueUsd || "0"),
    });
  }

  if (positionRows.length > 0) {
    await db.insert(positionSnapshots).values(positionRows);
  }

  return NextResponse.json({
    ok: true,
    skipped: false,
    address,
    capturedAt: capturedAt.toISOString(),
    snapshotId,
    positionsInserted: positionRows.length,
  });
}

// Vercel Cron uses GET requests :contentReference[oaicite:3]{index=3}
export async function GET(req: Request) {
  const expected = requireEnv("CRON_SECRET");
  const got = getAuthSecret(req);
  if (!got || got !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return takeSnapshot(req);
}

// Keep POST for your manual curl testing
export async function POST(req: Request) {
  const expected = requireEnv("CRON_SECRET");
  const got = getAuthSecret(req);
  if (!got || got !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return takeSnapshot(req);
}
