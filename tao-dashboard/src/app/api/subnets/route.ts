export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { ApiPromise, WsProvider } from "@polkadot/api";

/* =========================
   Helpers
========================= */

// Convert hex string (0x...) to bigint string safely
function hexToBigIntString(hex: string): string {
  try {
    if (typeof hex !== "string") return "0";
    const h = hex.startsWith("0x") ? hex : `0x${hex}`;
    return BigInt(h).toString();
  } catch {
    return "0";
  }
}

/**
 * Robustly extract an integer-like string from polkadot.js codec values.
 * Handles:
 * - plain strings/numbers/bigints
 * - arrays/tuples (takes first element)
 * - objects like { bits: "0x..." }
 * - codec objects with toJSON() that return array/object
 */
function toIntString(value: any): string {
  if (value == null) return "0";

  // Already a bigint
  if (typeof value === "bigint") return value.toString();

  // Number
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value).toString() : "0";

  // String: if it looks like an integer already, use it
  if (typeof value === "string") {
    const s = value.trim();
    if (/^-?\d+$/.test(s)) return s;
    // Sometimes codecs stringify to "[...]" – don't trust it; fall through
  }

  // If it's an array/tuple directly, take first element
  if (Array.isArray(value)) {
    return toIntString(value[0]);
  }

  // If codec has toJSON(), prefer it (more structured than toString())
  try {
    if (typeof value?.toJSON === "function") {
      const j = value.toJSON();

      if (j == null) return "0";
      if (typeof j === "number") return Math.trunc(j).toString();
      if (typeof j === "string") return toIntString(j);
      if (typeof j === "bigint") return j.toString();

      if (Array.isArray(j)) {
        // Most important fix: tuples come back as arrays; take first numeric
        return toIntString(j[0]);
      }

      if (typeof j === "object") {
        // Handle { bits: "0x..." }
        if ("bits" in j && typeof (j as any).bits === "string") {
          return hexToBigIntString((j as any).bits);
        }

        // Sometimes an object might have numeric keys
        if ("0" in j) return toIntString((j as any)[0]);
      }
    }
  } catch {
    // ignore and continue
  }

  // Last resort: try toString (may be "[...]" which we cannot BigInt directly)
  try {
    if (typeof value?.toString === "function") {
      const s = value.toString().trim();
      if (/^-?\d+$/.test(s)) return s;
    }
  } catch {
    // ignore
  }

  return "0";
}

// Fixed-point decode (assumes 1e9 scale)
function fixed9(raw: string): string {
  const neg = raw.startsWith("-");
  const s = neg ? raw.slice(1) : raw;

  // pad so we always have at least 10 digits to slice
  const padded = s.padStart(10, "0");
  const whole = padded.slice(0, -9);
  const frac = padded.slice(-9).replace(/0+$/, "");

  return `${neg ? "-" : ""}${whole || "0"}${frac ? "." + frac : ""}`;
}

function toBigIntSafe(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

// Percent with up to 6 decimals: "12.345678"
function pct6(numer: bigint, denom: bigint): string {
  if (denom === 0n) return "0";
  const scale = 1_000_000n;
  const v = (numer * 100n * scale) / denom;
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/* =========================
   Route
========================= */

export async function GET() {
  let api: ApiPromise | null = null;

  try {
    const provider = new WsProvider("wss://entrypoint-finney.opentensor.ai");
    api = await ApiPromise.create({ provider });

    const totalNetworks = Number(
      (await api.query.subtensorModule.totalNetworks()).toString()
    );

    const netuids = Array.from({ length: totalNetworks }, (_, i) => i);

    const [
      blockEmission,
      emissions,
      subnetTAOs,
      taoFlows,
      emaFlows,
      movingPrices,
      identities,
    ] = await Promise.all([
      api.query.subtensorModule.blockEmission(),
      api.query.subtensorModule.emission.multi(netuids),
      api.query.subtensorModule.subnetTAO.multi(netuids),
      api.query.subtensorModule.subnetTaoFlow.multi(netuids),
      api.query.subtensorModule.subnetEmaTaoFlow.multi(netuids),
      api.query.subtensorModule.subnetMovingPrice.multi(netuids),
      api.query.subtensorModule.subnetIdentitiesV3.multi(netuids),
    ]);

    // Emissions as raw integer strings (RAO units) for pct calc
    const emissionRaws = emissions.map((e: any) => toIntString(e));
    const totalEmissionRaw = emissionRaws.reduce(
      (acc: bigint, s: string) => acc + toBigIntSafe(s),
      0n
    );

    const subnets = netuids.map((netuid, idx) => {
      // Some of these may be tuples => toIntString will extract first numeric part
      const emissionRaw = emissionRaws[idx] ?? "0";
      const subnetTAORaw = toIntString(subnetTAOs[idx]);
      const taoFlowRaw = toIntString(taoFlows[idx]);
      const emaFlowRaw = toIntString(emaFlows[idx]);
      const movingPriceRaw = toIntString(movingPrices[idx]);

      const taoFlowBI = toBigIntSafe(taoFlowRaw);
      const emaFlowBI = toBigIntSafe(emaFlowRaw);

      const subnetTaoFlowDir =
        taoFlowBI > 0n ? "up" : taoFlowBI < 0n ? "down" : "flat";
      const subnetEmaTaoFlowDir =
        emaFlowBI > 0n ? "up" : emaFlowBI < 0n ? "down" : "flat";

      // Identity name extraction (best effort)
      let name: string | null = null;
      try {
        const human = identities[idx]?.toHuman?.() as any;
        name =
          human?.subnetName ??
          human?.name ??
          human?.identity?.name ??
          null;
      } catch {
        name = null;
      }

      return {
        netuid,
        name,

        // decoded human-friendly values
        emission: fixed9(emissionRaw),
        emissionPct: pct6(toBigIntSafe(emissionRaw), totalEmissionRaw),

        subnetTAO: fixed9(subnetTAORaw),
        subnetTaoFlow: fixed9(taoFlowRaw),
        subnetEmaTaoFlow: fixed9(emaFlowRaw),
        subnetMovingPrice: fixed9(movingPriceRaw),

        subnetTaoFlowDir,
        subnetEmaTaoFlowDir,
      };
    });

    return NextResponse.json({
      ok: true,
      updatedAt: new Date().toISOString(),
      totalNetworks,
      blockEmission: fixed9(toIntString(blockEmission)),
      subnets,
    });
  } catch (err: any) {
    console.error("API /api/subnets error:", err);

    return NextResponse.json(
      {
        ok: false,
        error: String(err?.message ?? err),
      },
      { status: 500 }
    );
  } finally {
    try {
      await api?.disconnect();
    } catch {
      // ignore
    }
  }
}
