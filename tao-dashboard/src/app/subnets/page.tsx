import SubnetsClient from "./SubnetsClient";

export const dynamic = "force-dynamic"; // ensures fresh data on dev + Vercel

type Subnet = {
  netuid: number;
  name: string | null;

  emission: string;
  emissionPct: string;
  subnetTAO: string;
  subnetTaoFlow: string;
  subnetTaoFlowDir: "up" | "down" | "flat";
  subnetEmaTaoFlow: string;
  subnetEmaTaoFlowDir: "up" | "down" | "flat";
  subnetMovingPrice: string;
};

type SubnetsResponse = {
  ok: boolean;
  updatedAt: string;
  totalNetworks: number;
  blockEmission: string;
  subnets: Subnet[];
};

export default async function SubnetsPage() {
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

  const res = await fetch(`${baseUrl}/api/subnets`, { cache: "no-store" });

  if (!res.ok) {
    return (
      <main className="min-h-screen p-6">
        <div className="mx-auto max-w-5xl rounded-2xl border border-white/10 bg-white/5 p-6">
          <h1 className="text-2xl font-bold">Subnets</h1>
          <p className="mt-2 text-gray-400">
            API request failed: <span className="text-gray-200">{res.status}</span>
          </p>
        </div>
      </main>
    );
  }

  const data: SubnetsResponse = await res.json();

  return (
    <main className="min-h-screen">
      <div className="p-4 sm:p-6">
        <div className="mx-auto max-w-5xl">
          {/* Header */}
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-3">
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Subnets</h1>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-300">
                  TAO Dashboard
                </span>
              </div>

              <p className="text-sm text-gray-400 mt-2">
                Updated: <span className="tabular-nums text-gray-200">{data.updatedAt}</span>
              </p>
            </div>

            <a
              href="/"
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-200 hover:bg-white/10 hover:text-white transition"
            >
              Home
            </a>
          </div>

          {/* Summary */}
          <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
            <div className="flex flex-wrap gap-4 text-sm">
              <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                <span className="text-gray-400">Total networks:</span>{" "}
                <span className="font-semibold tabular-nums text-cyan-200">{data.totalNetworks}</span>
              </div>

              <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                <span className="text-gray-400">Block emission (TAO/block):</span>{" "}
                <span className="font-semibold tabular-nums text-violet-200">
                  {data.blockEmission} TAO
                </span>
              </div>
            </div>

            <div className="mt-3 text-xs text-gray-500">
              Emission, TAO and flows are decoded into TAO units (RAO ÷ 1e9). Moving price is decoded
              from a fixed-point value (÷ 1e9).
            </div>
          </div>

          {/* Cards + controls */}
          <div className="mt-6">
            <SubnetsClient subnets={data.subnets} />
          </div>

          <div className="mt-10 text-xs text-gray-500">
            Tip: Use filters to find “Bullish + High Yield” candidates, then drill into details.
          </div>
        </div>
      </div>
    </main>
  );
}
