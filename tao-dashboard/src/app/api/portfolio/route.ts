import { NextResponse } from "next/server";

export const runtime = "nodejs";

function toIntString(v: unknown): string {
  if (v == null) return "0";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v).toString() : "0";
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return "0";
    const m = s.match(/-?\d+/);
    return m ? m[0] : "0";
  }
  if (Array.isArray(v)) return toIntString(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["value", "raw", "amount", "balance"]) {
      if (k in o) return toIntString(o[k]);
    }
    if ("free" in o) return toIntString(o.free);
    if (typeof (o as any).toString === "function") return toIntString(String((o as any).toString()));
  }
  return "0";
}

/** Convert rao (1e9) -> TAO string without floats. */
function fixed9(planckIntString: string): string {
  let s = (planckIntString ?? "").trim();
  if (!s) return "0";

  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);

  s = s.replace(/^0+(?=\d)/, "");

  if (s.length <= 9) {
    const frac = s.padStart(9, "0").replace(/0+$/, "");
    return neg ? `-${frac ? "0." + frac : "0"}` : frac ? "0." + frac : "0";
  }

  const whole = s.slice(0, -9);
  const fracRaw = s.slice(-9).replace(/0+$/, "");
  const out = fracRaw ? `${whole}.${fracRaw}` : whole;
  return neg ? `-${out}` : out;
}

function addIntStrings(a: string, b: string): string {
  return (BigInt(a || "0") + BigInt(b || "0")).toString();
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/**
 * Taostats responses often look like:
 * { pagination: ..., data: [...] } OR { data: {...} }.
 * Normalize to (data, raw).
 */
function unwrapTaostats(json: any): { ok: boolean; data: any; raw: any } {
  if (isRecord(json) && "data" in json) {
    const ok = typeof (json as any).ok === "boolean" ? Boolean((json as any).ok) : true;
    return { ok, data: (json as any).data, raw: json };
  }
  return { ok: true, data: json, raw: json };
}

async function fetchTaostatsFirstOk(args: {
  baseUrl: string;
  paramsVariants: Array<Record<string, string | number | undefined>>;
  headers: Record<string, string>;
  signal?: AbortSignal;
}): Promise<{ url: string; status: number; json: any; unwrapped: { ok: boolean; data: any; raw: any } }> {
  const { baseUrl, paramsVariants, headers, signal } = args;

  let lastErr: any = null;

  for (const params of paramsVariants) {
    const u = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, String(v));
    }

    try {
      const res = await fetch(u.toString(), {
        method: "GET",
        headers,
        cache: "no-store",
        signal,
      });

      const status = res.status;
      const text = await res.text();

      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { _nonJsonBody: text };
      }

      if (!res.ok) {
        lastErr = new Error(`HTTP ${status} from ${u.toString()}: ${text.slice(0, 200)}`);
        continue;
      }

      const unwrapped = unwrapTaostats(json);
      return { url: u.toString(), status, json, unwrapped };
    } catch (e: any) {
      lastErr = e;
      continue;
    }
  }

  throw lastErr ?? new Error("Taostats request failed for all parameter variants");
}

function toFiniteNumber(x: any): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function fmtUsd2(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n.toFixed(2);
}

/**
 * Get TAO/USD via CoinGecko (no API key required).
 * We keep this in the server route so the client never needs to fetch price.
 */
async function fetchTaoUsdPrice(signal?: AbortSignal): Promise<{
  ok: boolean;
  taoUsd: number;
  source: "coingecko";
  url: string;
  status: number | null;
  err: string | null;
  raw: any;
}> {
  const url =
    "https://api.coingecko.com/api/v3/simple/price?ids=bittensor&vs_currencies=usd";

  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal,
      headers: { Accept: "application/json" },
    });

    const status = res.status;
    const text = await res.text();

    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { _nonJsonBody: text };
    }

    const taoUsd = toFiniteNumber(json?.bittensor?.usd);

    return {
      ok: res.ok && taoUsd > 0,
      taoUsd,
      source: "coingecko",
      url,
      status,
      err: res.ok ? null : `HTTP ${status}`,
      raw: json,
    };
  } catch (e: any) {
    return {
      ok: false,
      taoUsd: 0,
      source: "coingecko",
      url,
      status: null,
      err: String(e?.message ?? e),
      raw: null,
    };
  }
}

export async function GET(request: Request) {
  const address =
    process.env.COLDKEY_ADDRESS ||
    process.env.NEXT_PUBLIC_COLDKEY_ADDRESS ||
    "5EUU3EgWe54K4aaunjUMGCZsCLUVeqR8SxUowkqiBZxrUufo";

  const apiKey = process.env.TAOSTATS_API_KEY || process.env.TAOSTATS_KEY || "";

  const url = new URL(request.url);
  const debugMode = url.searchParams.get("debug") === "1";

  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        updatedAt: new Date().toISOString(),
        address,
        error:
          "Missing TAOSTATS_API_KEY. Add TAOSTATS_API_KEY=... to your .env.local (server-side only, no NEXT_PUBLIC).",
      },
      { status: 500 }
    );
  }

  const headers: Record<string, string> = {
    Authorization: apiKey,
    "x-api-key": apiKey,
    Accept: "application/json",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    // Fetch TAO/USD in parallel (best-effort)
    const pricePromise = fetchTaoUsdPrice(controller.signal);

    // --- A) Account totals (free + staked totals) ---
    const accountCall = await fetchTaostatsFirstOk({
      baseUrl: "https://api.taostats.io/api/account/latest/v1",
      paramsVariants: [{ address }, { ss58: address }, { coldkey: address }, { coldkey_ss58: address }],
      headers,
      signal: controller.signal,
    });

    const accountData = accountCall.unwrapped.data;
    const accountRow =
      Array.isArray(accountData) ? accountData[0] : isRecord(accountData) ? accountData : null;

    const freeRao = toIntString(accountRow?.balance_free);
    const stakedTotalRao = toIntString(accountRow?.balance_staked);
    const stakedRootRao = toIntString(accountRow?.balance_staked_root);
    const stakedAlphaAsTaoRao = toIntString(accountRow?.balance_staked_alpha_as_tao);
    const balanceTotalRao = toIntString(accountRow?.balance_total);

    const stakedRao =
      stakedRootRao !== "0" || stakedAlphaAsTaoRao !== "0"
        ? addIntStrings(stakedRootRao, stakedAlphaAsTaoRao)
        : stakedTotalRao;

    const totalRao = addIntStrings(freeRao, stakedRao);

    // --- B) Stake positions (preferred) ---
    let stakePositions: any[] = [];
    let stakeCall: any = null;
    let stakeCallErr: string | null = null;

    try {
      stakeCall = await fetchTaostatsFirstOk({
        baseUrl: "https://api.taostats.io/api/dtao/stake_balance/latest/v1",
        paramsVariants: [{ coldkey: address }, { address }, { ss58: address }, { wallet: address }],
        headers,
        signal: controller.signal,
      });

      const stakeData = stakeCall.unwrapped.data;
      stakePositions = Array.isArray(stakeData)
        ? stakeData
        : isRecord(stakeData) && Array.isArray((stakeData as any).results)
          ? (stakeData as any).results
          : stakeData
            ? [stakeData]
            : [];
    } catch (e: any) {
      stakeCallErr = String(e?.message ?? e);
      stakePositions = [];
    }

    // --- FALLBACK: If stake_balance endpoint flakes, use accountRow.alpha_balances ---
    const alphaBalancesFallback = Array.isArray(accountRow?.alpha_balances) ? accountRow.alpha_balances : [];
    const usedFallback = stakePositions.length === 0 && alphaBalancesFallback.length > 0;

    const effectivePositions = usedFallback ? alphaBalancesFallback : stakePositions;

    // subnetValue excludes netuid 0 (root)
    let subnetValueRao = "0";
    for (const p of effectivePositions) {
      const netuid = Number((p as any)?.netuid);
      if (!Number.isFinite(netuid)) continue;
      if (netuid === 0) continue;
      subnetValueRao = addIntStrings(subnetValueRao, toIntString((p as any)?.balance_as_tao));
    }

    const subnetsBase = effectivePositions
      .map((p: any) => {
        const netuid = Number((p as any)?.netuid);
        if (!Number.isFinite(netuid)) return null;

        const alphaRao = toIntString((p as any)?.balance);
        const valueAsTaoRao = toIntString((p as any)?.balance_as_tao);

        return {
          netuid,
          name: String((p as any)?.subnet_name ?? ""),
          alphaBalance: fixed9(alphaRao),
          alphaPriceTao: "",
          valueTao: fixed9(valueAsTaoRao),
          // keep rao for accurate USD calc if needed later
          _valueAsTaoRao: valueAsTaoRao,
        };
      })
      .filter(Boolean) as Array<{
      netuid: number;
      name: string;
      alphaBalance: string;
      alphaPriceTao: string;
      valueTao: string;
      _valueAsTaoRao: string;
    }>;

    // totals
    const taoValueRao = balanceTotalRao !== "0" ? balanceTotalRao : totalRao;
    const totalValueRao = taoValueRao;

    // Wait for price
    const price = await pricePromise;
    const taoUsd = price.ok ? price.taoUsd : 0;

    // Compute USD values (display-grade; TAO -> USD)
    // We compute from TAO string for simplicity; if you want fully exact integer math later,
    // we can do rao * (usd*1e6) etc.
    const subnets = subnetsBase.map((s) => {
      const valueTaoNum = toFiniteNumber(s.valueTao);
      const valueUsdNum = taoUsd > 0 ? valueTaoNum * taoUsd : 0;

      return {
        netuid: s.netuid,
        name: s.name,
        alphaBalance: s.alphaBalance,
        alphaPriceTao: s.alphaPriceTao,
        valueTao: s.valueTao,
        valueUsd: taoUsd > 0 ? fmtUsd2(valueUsdNum) : "0",
      };
    });

    const totalValueTaoStr = fixed9(totalValueRao);
    const totalValueTaoNum = toFiniteNumber(totalValueTaoStr);
    const totalValueUsdNum = taoUsd > 0 ? totalValueTaoNum * taoUsd : 0;

    // Root stake (netuid 0) as a separate convenience field for your Root card
    const rootRow = subnetsBase.find((s) => s.netuid === 0) ?? null;
    const rootValueTao = rootRow ? rootRow.valueTao : "0";
    const rootValueUsdNum = taoUsd > 0 ? toFiniteNumber(rootValueTao) * taoUsd : 0;

    const payload: any = {
      ok: true,
      updatedAt: new Date().toISOString(),
      address,
      pricing: {
        taoUsd: taoUsd > 0 ? fmtUsd2(taoUsd) : "0",
        source: price.source,
      },
      tao: {
        free: fixed9(freeRao),
        staked: fixed9(stakedRao),
        total: fixed9(totalRao),
      },
      root: {
        netuid: 0,
        valueTao: rootValueTao,
        valueUsd: taoUsd > 0 ? fmtUsd2(rootValueUsdNum) : "0",
      },
      subnets,
      totals: {
        totalValueTao: totalValueTaoStr,
        totalValueUsd: taoUsd > 0 ? fmtUsd2(totalValueUsdNum) : "0",
        subnetValueTao: fixed9(subnetValueRao),
        taoValueTao: fixed9(taoValueRao),
      },
    };

    if (debugMode) {
      payload.debug = {
        taostats: {
          account: {
            url: accountCall.url,
            status: accountCall.status,
            extracted: {
              balance_free: freeRao,
              balance_staked: stakedTotalRao,
              balance_staked_root: stakedRootRao,
              balance_staked_alpha_as_tao: stakedAlphaAsTaoRao,
              balance_total: balanceTotalRao,
              alpha_balances_count: alphaBalancesFallback.length,
            },
          },
          stake_balance_latest: stakeCall
            ? {
                url: stakeCall.url,
                status: stakeCall.status,
                count: stakePositions.length,
              }
            : {
                ok: false,
                err: stakeCallErr,
              },
          positions: {
            usedFallback,
            returnedCount: effectivePositions.length,
            note: usedFallback
              ? "stake_balance_latest returned empty/failed; using account.alpha_balances instead."
              : "using stake_balance_latest",
          },
        },
        pricing: {
          taoUsd: taoUsd > 0 ? taoUsd : 0,
          provider: price.source,
          ok: price.ok,
          url: price.url,
          status: price.status,
          err: price.err,
          raw: price.raw,
        },
      };
    }

    return NextResponse.json(payload);
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        updatedAt: new Date().toISOString(),
        address,
        error: String(err?.message ?? err),
      },
      { status: 500 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
