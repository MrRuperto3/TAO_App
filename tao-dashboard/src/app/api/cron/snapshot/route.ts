import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  cronRuns,
  portfolioSnapshots,
  positionSnapshots,
  subnetMetricSnapshots,
} from "@/db/schema";

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

function getOptionalEnv(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
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

function toNumericOrNull(x: unknown): string | null {
  const s = toStr(x).trim();
  return s ? s : null;
}

function toNetuid(x: unknown): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function uniqNumbers(xs: number[]): number[] {
  return Array.from(new Set(xs)).sort((a, b) => a - b);
}

function utcDayKey(d: Date): string {
  // ISO format is always UTC; first 10 chars are YYYY-MM-DD
  return d.toISOString().slice(0, 10);
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

async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts?: FetchRetryOpts
) {
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
      const waitMs =
        retryAfterMs ?? computeBackoffMs(attempt, baseDelayMs, maxDelayMs);

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

  return async <T>(
    url: string,
    init?: RequestInit,
    opts?: FetchRetryOpts
  ): Promise<T> => {
    if (cache.has(url)) return cache.get(url) as T;

    const res = await fetchWithRetry(url, init, opts);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} from ${url}${body ? ` :: ${body.slice(0, 200)}` : ""}`
      );
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

/**
 * V1: Fetch subnet metrics from taostats for ONLY netuids you hold and store daily in subnet_metric_snapshots.
 * Fail-soft: if taostats fails, do NOT fail the entire cron snapshot.
 */
async function ingestSubnetMetrics(opts: {
  day: string;
  capturedAt: Date;
  netuids: number[];
}): Promise<{ inserted: number; skipped: number; note: string | null }> {
  const { day, capturedAt, netuids } = opts;

  let firstError: string | null = null;

  const apiKey = getOptionalEnv("TAOSTATS_API_KEY");
  if (!apiKey) {
    return { inserted: 0, skipped: 0, note: "TAOSTATS_API_KEY not set" };
  }

  const base = getOptionalEnv("TAOSTATS_BASE_URL") ?? "https://api.taostats.io";

  // Taostats documented endpoints (dTao)
  const poolLatestUrl = (netuid: number) =>
    `${base}/api/dtao/pool/latest/v1?netuid=${encodeURIComponent(String(netuid))}`;

  const flowUrl = (netuid: number) =>
    `${base}/api/dtao/tao_flow/v1?netuid=${encodeURIComponent(String(netuid))}`;

  const emissionUrl = (netuid: number) =>
    `${base}/api/dtao/subnet_emission/v1?netuid=${encodeURIComponent(String(netuid))}`;

  const fetchJson = makeCachedJsonFetcher();

  const TAOSTATS_RETRY: FetchRetryOpts = {
    maxRetries: 6,
    baseDelayMs: 750,
    maxDelayMs: 20_000,
    timeoutMs: 12_000,
    retryOnStatuses: [429, 500, 502, 503, 504],
  };

  const headers: Record<string, string> = {
    accept: "application/json",
    // Taostats expects the raw API key in the authorization header (no "Bearer " prefix)
    authorization: apiKey,
    // fallback (usually ignored, but harmless)
    "x-api-key": apiKey,
  };

  let inserted = 0;
  let skipped = 0;

  for (const netuid of netuids) {
    let pool: any = null;
    let flow: any = null;
    let emission: any = null;

    // Try pool
    try {
      pool = await fetchJson<any>(poolLatestUrl(netuid), { headers }, TAOSTATS_RETRY);
    } catch (e) {
      if (!firstError) {
        const msg = e instanceof Error ? e.message : String(e);
        firstError = `netuid=${netuid} :: pool :: ${msg}`;
      }
    }

    // Try flow
    try {
      flow = await fetchJson<any>(flowUrl(netuid), { headers }, TAOSTATS_RETRY);
    } catch (e) {
      if (!firstError) {
        const msg = e instanceof Error ? e.message : String(e);
        firstError = `netuid=${netuid} :: flow :: ${msg}`;
      }
    }

    // Try emission (optional)
    try {
      emission = await fetchJson<any>(emissionUrl(netuid), { headers }, TAOSTATS_RETRY);
    } catch (e) {
      if (!firstError) {
        const msg = e instanceof Error ? e.message : String(e);
        firstError = `netuid=${netuid} :: emission :: ${msg}`;
      }
    }

    // Unwrap taostats responses: they look like { pagination, data: [ {...} ] }
    const poolRow = Array.isArray(pool?.data) ? pool.data[0] : pool?.data ?? pool ?? null;
    const flowRow = Array.isArray(flow?.data) ? flow.data[0] : flow?.data ?? flow ?? null;
    const emissionRow = Array.isArray(emission?.data)
      ? emission.data[0]
      : emission?.data ?? emission ?? null;

    // Normalize defensively (store as strings; Drizzle numeric will accept string/null)
    const flow24h = toStr(
      flowRow?.flow_24h ??
        flowRow?.flow24h ??
        flowRow?.flow ??
        flowRow?.tao_flow_24h ??
        flowRow?.tao_flow ??
        ""
    );

    const emissionPct = toStr(
      emissionRow?.emission_pct ??
        emissionRow?.emissionPct ??
        emissionRow?.emission_percent ??
        emissionRow?.emission ??
        ""
    );

    const price = toStr(poolRow?.price ?? "");
    const liquidity = toStr(poolRow?.liquidity ?? "");

    // These may or may not exist in the pool payload; keep optional
    const taoVolume24h = toStr(
      poolRow?.tao_volume_24h ??
        poolRow?.taoVolume24h ??
        poolRow?.tao_volume ??
        poolRow?.volume_24h ??
        ""
    );

    const priceChange1d = toStr(
      poolRow?.price_change_1_day ??
        poolRow?.priceChange1d ??
        poolRow?.price_change_24h ??
        poolRow?.price_change_day ??
        ""
    );

    const priceChange1w = toStr(
      poolRow?.price_change_1_week ??
        poolRow?.priceChange1w ??
        poolRow?.price_change_7d ??
        ""
    );

    const priceChange1m = toStr(
      poolRow?.price_change_1_month ??
        poolRow?.priceChange1m ??
        poolRow?.price_change_30d ??
        ""
    );

    // Insert/update if we got ANY useful data
    const hasAny =
      (flow24h && flow24h !== "") ||
      (emissionPct && emissionPct !== "") ||
      (price && price !== "") ||
      (liquidity && liquidity !== "") ||
      (taoVolume24h && taoVolume24h !== "");

    if (hasAny) {
      // UPSERT so we can "repair" rows that were inserted as all-null earlier
      await db
        .insert(subnetMetricSnapshots)
        .values({
          day,
          netuid,
          capturedAt,
          flow24h: flow24h || null,
          emissionPct: emissionPct || null,
          price: price || null,
          liquidity: liquidity || null,
          taoVolume24h: taoVolume24h || null,
          priceChange1d: priceChange1d || null,
          priceChange1w: priceChange1w || null,
          priceChange1m: priceChange1m || null,
        })
        .onConflictDoUpdate({
          target: [subnetMetricSnapshots.day, subnetMetricSnapshots.netuid],
          set: {
            capturedAt,
            flow24h: flow24h || null,
            emissionPct: emissionPct || null,
            price: price || null,
            liquidity: liquidity || null,
            taoVolume24h: taoVolume24h || null,
            priceChange1d: priceChange1d || null,
            priceChange1w: priceChange1w || null,
            priceChange1m: priceChange1m || null,
          },
        });

      inserted++;
    } else {
      skipped++;
    }

    // Throttle between netuids to avoid 429s
    await sleep(600);
  }

  return { inserted, skipped, note: firstError };
}



async function takeSnapshot(req: Request) {
  const startedAt = Date.now();
  const ranAt = new Date();

  let ok = false;
  let skipped = false;
  let message: string | null = null;

  let snapshotsInserted = 0;
  let positionsInserted = 0;

  // We log these in the cronRuns.message (cron_runs table doesn't have columns for these yet)
  let subnetMetricsInserted = 0;
  let subnetMetricsSkipped = 0;
  let subnetMetricsNote: string | null = null;

  try {
    const address = requireEnv("COLDKEY_ADDRESS");

    // DEV-ONLY params: /api/cron/snapshot?force=1&day=YYYY-MM-DD
    const url = new URL(req.url);

    const force =
      process.env.NODE_ENV === "development" && url.searchParams.get("force") === "1";

    const dayOverride =
      process.env.NODE_ENV === "development" ? url.searchParams.get("day") : null;

    // Pin backfill snapshots to noon UTC for that day (stable bucket)
    const capturedAt = dayOverride ? new Date(`${dayOverride}T12:00:00.000Z`) : new Date();
    const dayKey = utcDayKey(capturedAt);


    const exists = await snapshotExistsForUtcDay({ address, capturedAt });
    if (exists && !force) {
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
    const portfolioJson = await fetchJson<PortfolioResponse>(
      `${baseUrl}/api/portfolio`,
      undefined,
      {
        maxRetries: 6,
        baseDelayMs: 750,
        maxDelayMs: 20_000,
        timeoutMs: 12_000,
        retryOnStatuses: [429, 500, 502, 503, 504],
      }
    );

    if (!portfolioJson?.ok) {
      throw new Error(portfolioJson?.error ?? "Failed to fetch /api/portfolio");
    }

    // Use totals + pricing from the payload (strings)
    const taoUsd = toNumericOrNull(portfolioJson?.pricing?.taoUsd);
    const totalValueTao = toNumericOrNull(portfolioJson?.totals?.totalValueTao);
    const totalValueUsd = toNumericOrNull(portfolioJson?.totals?.totalValueUsd);


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

    // -------------------- NEW: subnet metric ingestion (fail-soft) --------------------
    const heldNetuids = uniqNumbers(
      positionRows.filter((r) => r.positionType === "subnet").map((r) => r.netuid)
    );

    if (heldNetuids.length > 0) {
      const res = await ingestSubnetMetrics({
        day: dayKey,
        capturedAt,
        netuids: heldNetuids,
      });
      subnetMetricsInserted = res.inserted;
      subnetMetricsSkipped = res.skipped;
      subnetMetricsNote = res.note;
    }
    // ---------------------------------------------------------------------------------

    ok = true;

    const parts: string[] = [];
    if (force) parts.push("FORCE=1 (dev-only override)");
    parts.push(`OK: inserted snapshot + ${positionsInserted} positions`);
    if (heldNetuids.length > 0) {
      parts.push(
        `subnet metrics: inserted ${subnetMetricsInserted}, skipped ${subnetMetricsSkipped} (held netuids=${heldNetuids.length})`
      );
    }
    if (subnetMetricsNote) parts.push(`subnet metrics note: ${subnetMetricsNote}`);

    message = parts.join(" | ");

    return NextResponse.json({
      ok: true,
      skipped: false,
      force,
      address,
      capturedAt: capturedAt.toISOString(),
      day: dayKey,
      snapshotId,
      positionsInserted,
      subnetMetrics: {
        netuids: heldNetuids,
        inserted: subnetMetricsInserted,
        skipped: subnetMetricsSkipped,
        note: subnetMetricsNote,
      },
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
