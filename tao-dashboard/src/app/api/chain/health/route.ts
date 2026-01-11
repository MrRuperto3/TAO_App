import { NextResponse } from "next/server";
import { ApiPromise, HttpProvider, WsProvider } from "@polkadot/api";

const RPC_HTTP = [
  "https://bittensor-public.nodies.app",
  "https://bittensor-finney.api.onfinality.io/public",
];

const RPC_WS = [
  // Some providers support WebSocket; these may or may not work.
  "wss://bittensor-public.nodies.app",
  "wss://bittensor-finney.api.onfinality.io/public",
];

async function connect() {
  let lastErr: unknown;

  // Try HTTP providers first
  for (const url of RPC_HTTP) {
    try {
      const api = await ApiPromise.create({ provider: new HttpProvider(url) });
      await api.isReady;
      return api;
    } catch (e) {
      lastErr = e;
    }
  }

  // Then try WebSocket providers
  for (const url of RPC_WS) {
    try {
      const api = await ApiPromise.create({ provider: new WsProvider(url) });
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
    const [chain, nodeName, nodeVersion, health] = await Promise.all([
      api.rpc.system.chain(),
      api.rpc.system.name(),
      api.rpc.system.version(),
      api.rpc.system.health(),
    ]);

    return NextResponse.json({
      ok: true,
      chain: chain.toString(),
      nodeName: nodeName.toString(),
      nodeVersion: nodeVersion.toString(),
      health: health.toHuman(),
    });
  } finally {
    // Important for serverless: always disconnect
    await api.disconnect();
  }
}
