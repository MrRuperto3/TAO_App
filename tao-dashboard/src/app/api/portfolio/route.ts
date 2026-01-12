import { NextResponse } from "next/server";

export const runtime = "nodejs";

// -------------------------
// helpers (no floats for TAO)
// -------------------------
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
 * Taostats often returns:
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

// -------------------------
// APY helpers
// -------------------------
function parseApyDecimalToPctString(v: unknown): string {
  // Taostats yields like "0.195864..." (decimal fraction). Convert to percent string "19.59"
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n * 10000) / 100); // 2 decimals, no trailing formatting here
}

function mulRaoByApyDecimalToRao(weightRao: string, apyDecimal: unknown): string {
  // weighted contribution = stakeRao * apyDecimal
  // Use JS Number for apy (small), BigInt for stake; scale apy to basis points (1e4) to stay integer-ish.
  const apy = Number(apyDecimal);
  if (!Number.isFinite(apy) || apy <= 0) return "0";

  const stake = BigInt(weightRao || "0");
  // scale apy to 1e6 to reduce rounding noise (still safe in JS number range for apy)
  const scaled = BigInt(Math.round(apy * 1_000_000)); // apy * 1e6
  // contributionRaoScaled = stake * scaled
  const contribScaled = stake * scaled; // rao * 1e6
  // return contrib scaled (we’ll divide later)
  return contribScaled.toString();
}

function safeDivScaledApyToDecimal(contribScaledSum: string, stakeSumRao: string): number {
  // contribScaledSum is sum(stakeRao * apyDecimal * 1e6)
  // decimalApy = contribScaledSum / (stakeSumRao * 1e6)
  const stakeSum = BigInt(stakeSumRao || "0");
  if (stakeSum === 0n) return 0;

  const num = BigInt(contribScaledSum || "0");
  // Convert to Number carefully (values should be manageable for your wallet sizes; still, guard)
  const denom = stakeSum * 1_000_000n;

  // Compute as double with limited precision:
  const decimal = Number(num) / Number(denom);
  return Number.isFinite(decimal) ? decimal : 0;
}

// -------------------------
// Route
// -------------------------
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
    // --- Pricing (TAO/USD) ---
    // You already have this working (coingecko source in your output). Keep it as-is if you prefer.
    // We’ll try taostats first; if it fails, fall back to coingecko.
    let taoUsd = 0;
    let pricingSource: "taostats" | "coingecko" = "coingecko";

    try {
      const priceRes = await fetch("https://api.taostats.io/api/price/latest/v1", {
        cache: "no-store",
        headers,
        signal: controller.signal,
      });
      if (priceRes.ok) {
        const pj = await priceRes.json();
        const un = unwrapTaostats(pj).data;
        const row = Array.isArray(un) ? un[0] : un;
        const p = Number((row as any)?.price);
        if (Number.isFinite(p) && p > 0) {
          taoUsd = p;
          pricingSource = "taostats";
        }
      }
    } catch {
      // ignore, fallback below
    }

    if (!(Number.isFinite(taoUsd) && taoUsd > 0)) {
      try {
        const cg = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bittensor&vs_currencies=usd", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (cg.ok) {
          const j = await cg.json();
          const p = Number(j?.bittensor?.usd);
          if (Number.isFinite(p) && p > 0) {
            taoUsd = p;
            pricingSource = "coingecko";
          }
        }
      } catch {
        // ignore
      }
    }

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
      (stakedRootRao !== "0" || stakedAlphaAsTaoRao !== "0")
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

    // --- FALLBACK: accountRow.alpha_balances ---
    const alphaBalancesFallback = Array.isArray(accountRow?.alpha_balances) ? accountRow.alpha_balances : [];
    const usedFallback = stakePositions.length === 0 && alphaBalancesFallback.length > 0;
    const effectivePositions = usedFallback ? alphaBalancesFallback : stakePositions;

    // --- C) Fetch APY per (hotkey, netuid) via validator yield endpoint ---
    // Endpoint returns one_day_apy / seven_day_apy / thirty_day_apy (decimal fractions). :contentReference[oaicite:1]{index=1}
    const yieldDebug: Array<{ key: string; url?: string; status?: number; err?: string }> = [];

    const uniqueYieldKeys = new Map<string, { hotkey: string; netuid: number }>();
    for (const p of effectivePositions) {
      const hotkey = String((p as any)?.hotkey?.ss58 ?? (p as any)?.hotkey ?? "").trim();
      const netuid = Number((p as any)?.netuid);
      if (!hotkey || !Number.isFinite(netuid)) continue;
      uniqueYieldKeys.set(`${hotkey}::${netuid}`, { hotkey, netuid });
    }

    const yieldByKey = new Map<
      string,
      { oneDayApyDec: any; sevenDayApyDec: any; thirtyDayApyDec: any; name?: string }
    >();

    // small concurrency (wallets can have many positions; keep it gentle)
    const yieldJobs = Array.from(uniqueYieldKeys.entries()).map(async ([key, { hotkey, netuid }]) => {
      try {
        const yc = await fetchTaostatsFirstOk({
          baseUrl: "https://api.taostats.io/api/dtao/validator/yield/latest/v1",
          paramsVariants: [
            { hotkey, netuid },
            { hotkey_ss58: hotkey, netuid },
            { validator: hotkey, netuid },
            { hotkey, subnet: netuid },
          ],
          headers,
          signal: controller.signal,
        });

        const yd = yc.unwrapped.data;
        const row = Array.isArray(yd) ? yd[0] : yd;

        yieldByKey.set(key, {
          oneDayApyDec: (row as any)?.one_day_apy,
          sevenDayApyDec: (row as any)?.seven_day_apy,
          thirtyDayApyDec: (row as any)?.thirty_day_apy,
          name: String((row as any)?.name ?? ""),
        });

        yieldDebug.push({ key, url: yc.url, status: yc.status });
      } catch (e: any) {
        yieldDebug.push({ key, err: String(e?.message ?? e) });
      }
    });

    // throttle by batching
    const BATCH = 8;
    for (let i = 0; i < yieldJobs.length; i += BATCH) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(yieldJobs.slice(i, i + BATCH));
    }

    // subnetValue excludes netuid 0 (root)
    let subnetValueRao = "0";
    for (const p of effectivePositions) {
      const netuid = Number((p as any)?.netuid);
      if (!Number.isFinite(netuid) || netuid === 0) continue;
      subnetValueRao = addIntStrings(subnetValueRao, toIntString((p as any)?.balance_as_tao));
    }

    // Weighted APY (1D/7D/30D) for root and subnets separately:
    let rootStakeRao = "0";
    let subnetStakeRao = "0";

    let rootContrib1d = "0";
    let rootContrib7d = "0";
    let rootContrib30d = "0";

    let subnetContrib1d = "0";
    let subnetContrib7d = "0";
    let subnetContrib30d = "0";

    const subnets = effectivePositions
      .map((p: any) => {
        const netuid = Number((p as any)?.netuid);
        if (!Number.isFinite(netuid)) return null;

        const hotkey = String((p as any)?.hotkey?.ss58 ?? (p as any)?.hotkey ?? "").trim();
        const alphaRao = toIntString((p as any)?.balance);
        const valueAsTaoRao = toIntString((p as any)?.balance_as_tao);

        // APY lookup
        const yKey = `${hotkey}::${netuid}`;
        const y = yieldByKey.get(yKey);

        const apy1dPct = y ? parseApyDecimalToPctString(y.oneDayApyDec) : "";
        const apy7dPct = y ? parseApyDecimalToPctString(y.sevenDayApyDec) : "";
        const apy30dPct = y ? parseApyDecimalToPctString(y.thirtyDayApyDec) : "";

        // Weighted sums (using valueAsTaoRao as weight)
        if (netuid === 0) {
          rootStakeRao = addIntStrings(rootStakeRao, valueAsTaoRao);
          rootContrib1d = addIntStrings(rootContrib1d, mulRaoByApyDecimalToRao(valueAsTaoRao, y?.oneDayApyDec));
          rootContrib7d = addIntStrings(rootContrib7d, mulRaoByApyDecimalToRao(valueAsTaoRao, y?.sevenDayApyDec));
          rootContrib30d = addIntStrings(rootContrib30d, mulRaoByApyDecimalToRao(valueAsTaoRao, y?.thirtyDayApyDec));
        } else {
          subnetStakeRao = addIntStrings(subnetStakeRao, valueAsTaoRao);
          subnetContrib1d = addIntStrings(
            subnetContrib1d,
            mulRaoByApyDecimalToRao(valueAsTaoRao, y?.oneDayApyDec)
          );
          subnetContrib7d = addIntStrings(
            subnetContrib7d,
            mulRaoByApyDecimalToRao(valueAsTaoRao, y?.sevenDayApyDec)
          );
          subnetContrib30d = addIntStrings(
            subnetContrib30d,
            mulRaoByApyDecimalToRao(valueAsTaoRao, y?.thirtyDayApyDec)
          );
        }

        const valueTao = fixed9(valueAsTaoRao);
        const valueUsd =
          Number.isFinite(taoUsd) && taoUsd > 0
            ? (Number(valueTao) * taoUsd).toFixed(2)
            : "";

        return {
          netuid,
          name: String((p as any)?.subnet_name ?? ""),
          alphaBalance: fixed9(alphaRao),
          alphaPriceTao: "", // UI computes implied price if empty
          valueTao,
          valueUsd,
          apy: {
            oneDayPct: apy1dPct, // e.g. "19.59"
            sevenDayPct: apy7dPct,
            thirtyDayPct: apy30dPct,
          },
          hotkey: hotkey || undefined,
        };
      })
      .filter(Boolean) as Array<{
      netuid: number;
      name: string;
      alphaBalance: string;
      alphaPriceTao: string;
      valueTao: string;
      valueUsd: string;
      apy: { oneDayPct: string; sevenDayPct: string; thirtyDayPct: string };
      hotkey?: string;
    }>;

    // Root rollup
    const root = subnets.find((s) => s.netuid === 0) ?? null;

    // Total/tao values (as you had)
    const taoValueRao = balanceTotalRao !== "0" ? balanceTotalRao : totalRao;
    const totalValueRao = taoValueRao;

    const totalValueTao = fixed9(totalValueRao);
    const totalValueUsd =
      Number.isFinite(taoUsd) && taoUsd > 0 ? (Number(totalValueTao) * taoUsd).toFixed(2) : "";

    // Weighted APY summaries
    const rootApy1dDec = safeDivScaledApyToDecimal(rootContrib1d, rootStakeRao);
    const rootApy7dDec = safeDivScaledApyToDecimal(rootContrib7d, rootStakeRao);
    const rootApy30dDec = safeDivScaledApyToDecimal(rootContrib30d, rootStakeRao);

    const subnetApy1dDec = safeDivScaledApyToDecimal(subnetContrib1d, subnetStakeRao);
    const subnetApy7dDec = safeDivScaledApyToDecimal(subnetContrib7d, subnetStakeRao);
    const subnetApy30dDec = safeDivScaledApyToDecimal(subnetContrib30d, subnetStakeRao);

    const payload: any = {
      ok: true,
      updatedAt: new Date().toISOString(),
      address,
      pricing: {
        taoUsd: Number.isFinite(taoUsd) && taoUsd > 0 ? taoUsd.toFixed(2) : "0",
        source: pricingSource,
      },
      tao: {
        free: fixed9(freeRao),
        staked: fixed9(stakedRao),
        total: fixed9(totalRao),
      },
      root: root
        ? {
            netuid: 0,
            valueTao: root.valueTao,
            valueUsd: root.valueUsd,
            apy: {
              oneDayPct: root.apy.oneDayPct,
              sevenDayPct: root.apy.sevenDayPct,
              thirtyDayPct: root.apy.thirtyDayPct,
            },
          }
        : null,
      apySummary: {
        root: {
          oneDayPct: rootStakeRao !== "0" ? String(Math.round(rootApy1dDec * 10000) / 100) : "",
          sevenDayPct: rootStakeRao !== "0" ? String(Math.round(rootApy7dDec * 10000) / 100) : "",
          thirtyDayPct: rootStakeRao !== "0" ? String(Math.round(rootApy30dDec * 10000) / 100) : "",
        },
        subnets: {
          oneDayPct: subnetStakeRao !== "0" ? String(Math.round(subnetApy1dDec * 10000) / 100) : "",
          sevenDayPct: subnetStakeRao !== "0" ? String(Math.round(subnetApy7dDec * 10000) / 100) : "",
          thirtyDayPct: subnetStakeRao !== "0" ? String(Math.round(subnetApy30dDec * 10000) / 100) : "",
        },
      },
      subnets,
      totals: {
        totalValueTao,
        totalValueUsd,
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
            ? { url: stakeCall.url, status: stakeCall.status, count: stakePositions.length }
            : { ok: false, err: stakeCallErr },
          positions: {
            usedFallback,
            returnedCount: effectivePositions.length,
          },
          validator_yield: {
            fetched: yieldByKey.size,
            attempts: yieldDebug.slice(0, 25), // cap debug size
            note: "APY is returned as decimal fraction (e.g. 0.19 = 19%).",
          },
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
