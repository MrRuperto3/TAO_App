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

export async function GET() {
  const api = await connect();

  try {
    const md = api.runtimeMetadata.asLatest;
    const pallets = md.pallets
      .map((p) => ({
        name: p.name.toString(),
        hasStorage: p.storage.isSome,
      }))
      .filter((p) => p.hasStorage)
      // focus on subtensor-ish pallets
      .filter((p) => p.name.toLowerCase().includes("subtensor"));

    const details = pallets.map((p) => {
      const pallet = md.pallets.find((x) => x.name.toString() === p.name)!;
      const storage = pallet.storage.unwrap();
      const items = storage.items.map((i) => i.name.toString());
      return { pallet: p.name, storageItems: items };
    });

    return NextResponse.json({
      ok: true,
      rpc: (api as any)._options?.provider?.endpoint ?? "connected",
      pallets: details,
    });
  } finally {
    await api.disconnect();
  }
}
