import { NextResponse } from "next/server";
import { ApiPromise, HttpProvider } from "@polkadot/api";

const RPC_HTTP = [
  "https://bittensor-public.nodies.app",
  "https://bittensor-finney.api.onfinality.io/public",
];

async function connect() {
  let lastErr: unknown;
  for (const url of RPC_HTTP) {
    try {
      const api = await ApiPromise.create({ provider: new HttpProvider(url) });
      await api.isReady;
      return api;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Failed to connect to any public RPC endpoint");
}

function pickString(v: any): string | null {
  if (v == null) return null;

  // v may be { Raw: "..." } or just a string, depending on chain/runtime
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);

  // Polkadot codec values
  try {
    if (typeof v.toHuman === "function") {
      const h = v.toHuman();
      if (typeof h === "string") return h;
      if (h && typeof h === "object") {
        // Common pattern: { Raw: "..." }
        const raw = (h as any).Raw;
        if (typeof raw === "string") return raw;
      }
      return JSON.stringify(h);
    }
  } catch {}

  try {
    if (typeof v.toString === "function") return v.toString();
  } catch {}

  return null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ netuid: string }> }
) {
  const { netuid } = await params;
  const id = Number(netuid);

  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: "Invalid netuid" }, { status: 400 });
  }

  const api = await connect();

  try {
    // Try SubnetIdentitiesV3 first (best match for subnet metadata)
    // Note: some entries may be empty if the subnet hasn't set an identity.
    const v3 = await api.query.subtensorModule.subnetIdentitiesV3(id);

    // If nothing is set, it may return null-ish / empty.
    // We'll return whatever we can parse.
    let human: any = null;
    try {
      human = typeof (v3 as any).toHuman === "function" ? (v3 as any).toHuman() : null;
    } catch {}

    // Try to extract common fields if present.
    // Depending on runtime, field names can vary. We'll be defensive.
    const name =
      pickString((human as any)?.name) ??
      pickString((human as any)?.subnetName) ??
      pickString((human as any)?.Name) ??
      null;

    const description =
      pickString((human as any)?.description) ??
      pickString((human as any)?.subnetDescription) ??
      pickString((human as any)?.Description) ??
      null;

    const url =
      pickString((human as any)?.url) ??
      pickString((human as any)?.website) ??
      pickString((human as any)?.Url) ??
      null;

    const discord =
      pickString((human as any)?.discord) ??
      pickString((human as any)?.Discord) ??
      null;

    const github =
      pickString((human as any)?.github) ??
      pickString((human as any)?.Github) ??
      null;

    // Fallback: return the full toHuman so we can see the exact shape
    return NextResponse.json({
      ok: true,
      netuid: id,
      identity: { name, description, url, discord, github },
      rawHuman: human,
    });
  } finally {
    await api.disconnect();
  }
}
