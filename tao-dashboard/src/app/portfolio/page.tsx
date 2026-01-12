export const dynamic = "force-dynamic";

type PortfolioResponse = {
  ok: boolean;
  updatedAt: string;
  address: string;
  pricing?: {
    taoUsd?: string; // "xx.xx"
    source?: string;
  };
  tao: { free: string; staked: string; total: string };
  root?: {
    netuid: number;
    valueTao: string;
    valueUsd?: string; // "xx.xx"
  };
  subnets: Array<{
    netuid: number;
    name: string; // may be empty from API
    alphaBalance: string;
    alphaPriceTao: string; // may be empty from API
    valueTao: string;
    valueUsd?: string; // "xx.xx"
  }>;
  totals: {
    totalValueTao: string;
    totalValueUsd?: string; // "xx.xx"
    subnetValueTao: string;
    taoValueTao: string;
  };
  error?: string;
};

type SubnetsApiResponse = {
  ok: boolean;
  updatedAt?: string;
  subnets?: Array<{
    netuid: number;
    name?: string;
  }>;
  error?: string;
};

function getBaseUrl() {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

async function getPortfolio(): Promise<PortfolioResponse> {
  const res = await fetch(`${getBaseUrl()}/api/portfolio`, { cache: "no-store" });
  return res.json();
}

async function getSubnetNames(): Promise<Map<number, string>> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/subnets`, { cache: "no-store" });
    const json: SubnetsApiResponse = await res.json();

    const m = new Map<number, string>();
    if (json?.ok && Array.isArray(json.subnets)) {
      for (const s of json.subnets) {
        const netuid = Number((s as any)?.netuid);
        if (!Number.isFinite(netuid)) continue;
        const name = String((s as any)?.name ?? "").trim();
        if (name) m.set(netuid, name);
      }
    }
    return m;
  } catch {
    return new Map();
  }
}

function toNum(x: string): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function fmtPriceTao(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1) return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return n.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtUsdCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
}

export default async function PortfolioPage() {
  const [data, nameMap] = await Promise.all([getPortfolio(), getSubnetNames()]);

  // TAO/USD comes from our own API now
  const taoUsd = toNum(String(data.pricing?.taoUsd ?? "0"));

  // Prefer root from explicit API field; fallback to netuid 0 row in subnets
  const rootFromApi = data.root ?? null;
  const rootFromSubnets = (data.subnets ?? []).find((s) => s.netuid === 0) ?? null;

  const rootValueTao = rootFromApi?.valueTao ?? rootFromSubnets?.valueTao ?? "0";
  const rootValueUsd =
    rootFromApi?.valueUsd ??
    (taoUsd > 0 ? String((toNum(rootValueTao) * taoUsd).toFixed(2)) : "0");

  // Enrich subnets:
  // - name from /api/subnets if missing
  // - price (TAO) = valueTao / alphaBalance if missing
  // - USD value comes from API (or computed as fallback)
  const subnetPositions = (data.subnets ?? [])
    .filter((s) => s.netuid !== 0)
    .map((s) => {
      const netuid = s.netuid;

      const fallbackName = nameMap.get(netuid) ?? "";
      const name = s.name?.trim() || fallbackName || `Subnet ${netuid}`;

      const alpha = toNum(s.alphaBalance);
      const valueTaoNum = toNum(s.valueTao);
      const computedPriceTao = alpha > 0 && valueTaoNum > 0 ? valueTaoNum / alpha : 0;

      const alphaPriceTao = s.alphaPriceTao?.trim() ? s.alphaPriceTao : fmtPriceTao(computedPriceTao);

      // Prefer API-provided USD; fallback to computed
      const apiUsd = toNum(String(s.valueUsd ?? "0"));
      const valueUsdNum = apiUsd > 0 ? apiUsd : taoUsd > 0 ? valueTaoNum * taoUsd : NaN;

      return {
        ...s,
        name,
        alphaPriceTao,
        valueUsdNum,
      };
    });

  const totalValueTaoNum = toNum(data?.totals?.totalValueTao ?? "0");
  const totalValueUsdNum = toNum(String(data?.totals?.totalValueUsd ?? "0"));

  return (
    <main className="min-h-screen px-4 py-8">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Portfolio</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Read-only wallet view (TAO + subnet tokens). Updated:{" "}
            <span className="text-zinc-300">{data.updatedAt}</span>
          </p>
          <p className="mt-1 text-xs text-zinc-500 break-all">Address: {data.address}</p>

          <p className="mt-1 text-xs text-zinc-600">
            TAO/USD:{" "}
            <span className="text-zinc-400">
              {taoUsd > 0 ? fmtUsd(taoUsd) : "—"}
            </span>
            {data.pricing?.source ? (
              <span className="text-zinc-600">{" "}• source: {data.pricing.source}</span>
            ) : null}
          </p>
        </div>

        {!data.ok ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-red-200">
            <div className="font-medium">API error</div>
            <div className="mt-1 text-sm break-words">{data.error ?? "Unknown error"}</div>
          </div>
        ) : (
          <>
            {/* Top Summary Cards */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                <div className="text-xs text-zinc-400">Total Value (TAO)</div>
                <div className="mt-2 text-2xl font-semibold text-zinc-100">{data.totals.totalValueTao}</div>
                <div className="mt-1 text-xs text-zinc-500">(TAO + subnets)</div>
                <div className="mt-2 text-sm text-zinc-200">
                  {Number.isFinite(totalValueUsdNum) ? fmtUsd(totalValueUsdNum) : "—"}
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                <div className="text-xs text-zinc-400">TAO Free</div>
                <div className="mt-2 text-2xl font-semibold text-zinc-100">{data.tao.free}</div>
                <div className="mt-1 text-xs text-zinc-500">On-wallet balance</div>
                <div className="mt-2 text-sm text-zinc-200">
                  {taoUsd > 0 ? fmtUsd(toNum(data.tao.free) * taoUsd) : "—"}
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                <div className="text-xs text-zinc-400">TAO Staked</div>
                <div className="mt-2 text-2xl font-semibold text-zinc-100">{data.tao.staked}</div>
                <div className="mt-1 text-xs text-zinc-500">Root + subnet stake (TAO value)</div>
                <div className="mt-2 text-sm text-zinc-200">
                  {taoUsd > 0 ? fmtUsd(toNum(data.tao.staked) * taoUsd) : "—"}
                </div>
              </div>
            </div>

            {/* Root Stake Card */}
            <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-zinc-100">Root Stake</div>
                  <div className="mt-1 text-xs text-zinc-500">Staked TAO delegated to Root (netuid 0)</div>
                </div>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <div>
                  <div className="text-xs text-zinc-400">Staked TAO</div>
                  <div className="mt-1 text-lg font-medium text-zinc-100">{rootValueTao}</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {taoUsd > 0 ? fmtUsd(toNum(rootValueUsd)) : "—"}
                  </div>
                </div>

                <div>
                  <div className="text-xs text-zinc-400">Price</div>
                  <div className="mt-1 text-lg font-medium text-zinc-100">1 TAO</div>
                </div>

                <div>
                  <div className="text-xs text-zinc-400">NetUID</div>
                  <div className="mt-1 text-lg font-medium text-zinc-100">0</div>
                </div>
              </div>
            </div>

            {/* Subnet Positions Table */}
            <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-zinc-100">Subnet Positions</div>
                  <div className="mt-1 text-xs text-zinc-500">Alpha balances + implied TAO pricing per subnet.</div>
                </div>
                <div className="text-xs text-zinc-500">{subnetPositions.length} positions</div>
              </div>

              {subnetPositions.length === 0 ? (
                <div className="mt-4 text-sm text-zinc-400">No subnet positions yet.</div>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-zinc-500">
                      <tr>
                        <th className="py-2 pr-4">NetUID</th>
                        <th className="py-2 pr-4">Name</th>
                        <th className="py-2 pr-4">Alpha</th>
                        <th className="py-2 pr-4">Price (TAO)</th>
                        <th className="py-2 pr-4">Value (TAO)</th>
                        <th className="py-2 pr-0">Value (USD)</th>
                      </tr>
                    </thead>
                    <tbody className="text-zinc-200">
                      {subnetPositions.map((s) => (
                        <tr key={s.netuid} className="border-t border-zinc-800">
                          <td className="py-2 pr-4">{s.netuid}</td>
                          <td className="py-2 pr-4">
                            {s.name ? <span className="text-zinc-100">{s.name}</span> : <span className="text-zinc-500">—</span>}
                          </td>
                          <td className="py-2 pr-4">{s.alphaBalance}</td>
                          <td className="py-2 pr-4">
                            {s.alphaPriceTao ? s.alphaPriceTao : <span className="text-zinc-500">—</span>}
                          </td>
                          <td className="py-2 pr-4">{s.valueTao}</td>
                          <td className="py-2 pr-0">
                            {Number.isFinite(s.valueUsdNum) ? fmtUsd(s.valueUsdNum) : <span className="text-zinc-500">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="mt-3 text-xs text-zinc-500">
                    Price is implied as <span className="text-zinc-400">Value ÷ Alpha</span>. USD values use{" "}
                    <span className="text-zinc-400">TAO/USD</span> returned by <span className="text-zinc-400">/api/portfolio</span>.
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
