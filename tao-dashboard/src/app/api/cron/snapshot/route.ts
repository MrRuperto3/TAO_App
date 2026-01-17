import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { cronRuns, portfolioSnapshots, positionSnapshots } from "@/db/schema";

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
  // Vercel cron: Authorization: Bearer <CRON_SECRET>
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
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";

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

/* ------------------------------ Retry Helpers ------------------------------ */

type FetchRetryOpts = {
  maxRetries?: number; // retries after first attempt
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  retryOnStatuses?: number[];
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterMs(res: Response): number | null {
  const ra = res.headers.get("retry-after");
  if (!ra) return null;

  // Retry-After can be seconds or an HTTP date
  const seconds = Number(ra);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(ra);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

function computeBackoffMs(attempt: number, base: number, max: number) {
  const exp = Math.min(max, base * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * 250); // 0-250ms
  return exp + jitter;
}

async function fetchWithRetry(url: string, init?: RequestInit, opts?: FetchRetryOpts) {
  const {
    maxRetries = 6,
    baseDelayMs = 750,
    maxDelayMs = 20_000,
    timeoutMs = 12_000,
    retryOnStatuses = [429, 500, 502, 503, 504],
  } = opts ?? {};

  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        cache: "no-store",
      });

      clearTimeout(t);

      if (res.ok) return res;

      // Most 4xx are non-retriable; 429 is retriable by default
      if (!retryOnStatuses.includes(res.status)) {
        return res;
      }

      // drain body so connections aren’t held
      try {
        await res.text();
      } catch {}

      const retryAfterMs = parseRetryAfterMs(res);
      const waitMs = retryAfterMs ?? computeBackoffMs(attempt, baseDelayMs, maxDelayMs);

      if (attempt < maxRetries) {
        await sleep(waitMs);
        continue;
      }

      return res;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;

      const waitMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
      if (attempt < maxRetries) {
        await sleep(waitMs);
        continue;
      }
    }
  }

  throw lastErr ?? new Error("fetchWithRetry failed");
}

function makeCachedJsonFetcher() {
  const cache = new Map<string, any>();

  return async <T>(url: string, init?: RequestInit, opts?: FetchRetryOpts): Promise<T> => {
    if (cache.has(url)) return cache.get(url) as T;

    const res = await fetchWithRetry(url, init, opts);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} from ${url}${body ? ` :: ${body.slice(0, 200)}` : ""}`);
    }

    const json = (await res.json()) as T;
    cache.set(url, json);
    return json;
  };
}

/* ------------------------------ Snapshot Logic ----------------------------- */

async function snapshotExistsForUtcDay(opts: {
  address: string;
  capturedAt: Date;
}): Promise<boolean> {
  const { address, capturedAt } = opts;

  // Compare day buckets in UTC.
  // date_trunc('day', timestamptz) buckets by UTC date for timestamptz.
  const rows = await db
    .select({ id: portfolioSnapshots.id })
    .from(portfolioSnapshots)
    .where(
      and(
        eq(portfolioSnapshots.address, address),
        sql`date_trunc('day', ${portfolioSnapshots.capturedAt}) = date_trunc('day', ${capturedAt.toISOString()}::timestamptz)`
      )
    )
    .limit(1);

  return rows.length > 0;
}

async function takeSnapshot(req: Request) {
  const startedAt = Date.now();
  const ranAt = new Date();

  let ok = false;
  let skipped = false;
  let message: string | null = null;

  let snapshotsInserted = 0;
  let positionsInserted = 0;

  try {
    const address = requireEnv("COLDKEY_ADDRESS");
    const capturedAt = new Date();

    // hourly idempotency
    const exists = await snapshotExistsForUtcDay({ address, capturedAt });
    if (exists) {
      skipped = true;
      ok = true;
      message = "Skipped: snapshot already exists for UTC day";

      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "snapshot already exists for UTC day",
        address,
        capturedAt: capturedAt.toISOString(),
      });
    }

    const baseUrl = getBaseUrlFromRequest(req);
    const fetchJson = makeCachedJsonFetcher();

    // Fetch normalized portfolio data from your existing BFF (with retry/backoff)
    const portfolioJson = await fetchJson<PortfolioResponse>(`${baseUrl}/api/portfolio`, undefined, {
      maxRetries: 6,
      baseDelayMs: 750,
      maxDelayMs: 20_000,
      timeoutMs: 12_000,
      retryOnStatuses: [429, 500, 502, 503, 504],
    });

    if (!portfolioJson?.ok) {
      // Fail with 502 so cron health clearly shows the snapshot ingest failed due to upstream
      throw new Error(portfolioJson?.error ?? "Failed to fetch /api/portfolio");
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
    if (!snapshotId) throw new Error("Failed to insert portfolio snapshot");

    snapshotsInserted = 1;

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
      positionsInserted = positionRows.length;
    }

    ok = true;
    message = `OK: inserted snapshot + ${positionsInserted} positions`;

    return NextResponse.json({
      ok: true,
      skipped: false,
      address,
      capturedAt: capturedAt.toISOString(),
      snapshotId,
      positionsInserted,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : "Unknown error";
    message = `FAILED: ${m}`;

    return NextResponse.json({ ok: false, error: m }, { status: 502 });
  } finally {
    const durationMs = Date.now() - startedAt;

    // Best-effort logging (never break cron response)
    try {
      await db.insert(cronRuns).values({
        job: "snapshot",
        ranAt,
        ok,
        message,
        durationMs,
        snapshotsInserted,
        positionsInserted,
      });
    } catch {
      // fail-soft
    }
  }
}

// Vercel Cron uses GET requests
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
