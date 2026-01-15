export const dynamic = "force-dynamic";

type HistoryPosition = {
  positionType: "root" | "subnet";
  netuid: number;
  hotkey: string | null;
  apy: {
    oneDayPct: string;
    sevenDayPct: string;
    thirtyDayPct: string;
  };
};

type HistoryResponse = {
  ok: boolean;
  positions: HistoryPosition[];
};

type PortfolioResponse = {
  ok: boolean;
  updatedAt: string;
  address: string;

  pricing?: {
    taoUsd: string; // e.g. "288.51"
    source: string; // e.g. "coingecko" | "taostats"
  };

  tao: { free: string; staked: string; total: string };

  root?:
    | {
        netuid: 0;
        valueTao: string;
        valueUsd: string; // e.g. "4013.63"
        apy?: { oneDayPct: string; sevenDayPct: string; thirtyDayPct: string };
      }
    | null;

  apySummary?: {
    root?: { oneDayPct: string; sevenDayPct: string; thirtyDayPct: string };
    subnets?: { oneDayPct: string; sevenDayPct: string; thirtyDayPct: string };
  };

  subnets: Array<{
    netuid: number;
    name: string; // may be empty from API
    alphaBalance: string;
    alphaPriceTao: string; // may be empty from API
    valueTao: string;
    valueUsd?: string; // "287.91" etc
    apy?: { oneDayPct: string; sevenDayPct: string; thirtyDayPct: string };
    hotkey?: string; // optional in UI type (present in API payload)
  }>;

  totals: {
    totalValueTao: string;
    totalValueUsd?: string; // "5508.45"
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

async function getPortfolioHistory(): Promise<HistoryResponse> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/portfolio/history?days=30`, { cache: "no-store" });
    return (await res.json()) as HistoryResponse;
  } catch {
    return { ok: false, positions: [] };
  }
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

function toNum(x: string | undefined | null): number {
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

function fmtUsdFromString(s?: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return "—";
  return fmtUsd(n);
}

// Existing “estimated APY” formatting (keeps prior behavior: hides <= 0)
function fmtPct(pctString: string | undefined): string {
  const n = Number(pctString);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `${n.toFixed(2)}%`;
}

// Realized APY formatting: allow negative values (show them), but still fail-soft on missing/NaN
function fmtPctAny(pctString: string | undefined | null): string {
  if (!pctString || !pctString.trim()) return "—";
  const n = Number(pctString);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

export default async function PortfolioPage() {
  const [data, nameMap, history] = await Promise.all([
    getPortfolio(),
    getSubnetNames(),
    getPortfolioHistory(),
  ]);

  // Build realized APY lookup keyed by "positionType:netuid"
  const realizedApyByKey = new Map<string, HistoryPosition["apy"]>();
  if (history?.ok && Array.isArray(history.positions)) {
    for (const p of history.positions) {
      const key = `${p.positionType}:${p.netuid}`;
      realizedApyByKey.set(key, p.apy);
    }
  }

  const getRealizedApy = (positionType: "root" | "subnet", netuid: number) => {
    const key = `${positionType}:${netuid}`;
    return realizedApyByKey.get(key) ?? null;
  };

  // TAO/USD comes from the API payload now
  const taoUsd = toNum(data?.pricing?.taoUsd);

  // Root position: prefer dedicated "root" object, fallback to netuid 0 in subnets array
  const rootPosition =
    data.root ??
    ((data.subnets ?? []).find((s) => s.netuid === 0)
      ? {
          netuid: 0 as const,
          valueTao: (data.subnets ?? []).find((s) => s.netuid === 0)?.valueTao ?? "0",
          valueUsd: (data.subnets ?? []).find((s) => s.netuid === 0)?.valueUsd ?? "",
          apy: (data.subnets ?? []).find((s) => s.netuid === 0)?.apy,
        }
      : null);

  const rootRealized = getRealizedApy("root", 0);

  // Subnet positions (exclude netuid 0), enrich name + implied TAO price
  const subnetPositions = (data.subnets ?? [])
    .filter((s) => s.netuid !== 0)
    .map((s) => {
      const netuid = s.netuid;

      const fallbackName = nameMap.get(netuid) ?? "";
      const name = s.name?.trim() || fallbackName || `Subnet ${netuid}`;

      const alpha = toNum(s.alphaBalance);
      const valueTao = toNum(s.valueTao);
      const impliedPriceTao = alpha > 0 && valueTao > 0 ? valueTao / alpha : 0;

      const alphaPriceTao = s.alphaPriceTao?.trim()
        ? s.alphaPriceTao
        : fmtPriceTao(impliedPriceTao);

      return {
        ...s,
        name,
        alphaPriceTao,
      };
    });

  const totalValueUsd = fmtUsdFromString(data?.totals?.totalValueUsd);

  // If totals.totalValueUsd ever goes missing, compute it
  const computedTotalUsd =
    !data?.totals?.totalValueUsd && taoUsd > 0
      ? fmtUsd(toNum(data?.totals?.totalValueTao) * taoUsd)
      : null;

  return (
    <main className="min-h-screen">
      <div className="p-4 sm:p-6">
       <div className="mx-auto w-full max-w-5xl">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
                Portfolio
              </h1>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-300">
                TAO Dashboard
              </span>
            </div>

            <p className="mt-1 text-sm text-zinc-400">
              Read-only wallet view (TAO + subnet tokens). Updated:{" "}
              <span className="text-zinc-300">{data.updatedAt}</span>
            </p>

            <p className="mt-1 text-xs text-zinc-500 break-all">
              Address: {data.address}
            </p>

            <p className="mt-1 text-xs text-zinc-600">
              TAO/USD:{" "}
              <span className="text-zinc-400">
                {taoUsd > 0 ? fmtUsd(taoUsd) : "—"}
              </span>
              {data?.pricing?.source ? (
                <span className="text-zinc-600">
                  {" "}• source: {data.pricing.source}
                </span>
              ) : null}
            </p>
          </div>

  <a
    href="/"
    className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-200 hover:bg-white/10 hover:text-white transition"
  >
    Home
  </a>
</div>


        {!data.ok ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-red-200">
            <div className="font-medium">API error</div>
            <div className="mt-1 text-sm break-words">{data.error ?? "Unknown error"}</div>
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                <div className="text-xs text-zinc-400">Total Value</div>
                <div className="mt-2 text-2xl font-semibold text-zinc-100">
                  {data.totals.totalValueTao}{" "}
                  <span className="text-sm font-normal text-zinc-400">TAO</span>
                </div>
                <div className="mt-1 text-sm text-zinc-200">
                  {data?.totals?.totalValueUsd ? totalValueUsd : computedTotalUsd ?? "—"}
                </div>
                <div className="mt-1 text-xs text-zinc-500">(TAO + staked positions)</div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                <div className="text-xs text-zinc-400">TAO Free</div>
                <div className="mt-2 text-2xl font-semibold text-zinc-100">{data.tao.free}</div>
                <div className="mt-1 text-xs text-zinc-500">On-wallet balance</div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                <div className="text-xs text-zinc-400">TAO Staked</div>
                <div className="mt-2 text-2xl font-semibold text-zinc-100">{data.tao.staked}</div>
                <div className="mt-1 text-xs text-zinc-500">Root + subnet stake (TAO value)</div>
                <div className="mt-2 text-sm sm:text-xs text-zinc-400">
                  Est. APY (1D):{" "}
                  <span className="text-zinc-200">{fmtPct(data?.apySummary?.subnets?.oneDayPct)}</span>
                  <span className="text-zinc-600">
                    {" "}• root: {fmtPct(data?.apySummary?.root?.oneDayPct)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  7D: {fmtPct(data?.apySummary?.subnets?.sevenDayPct)} • 30D:{" "}
                  {fmtPct(data?.apySummary?.subnets?.thirtyDayPct)}
                </div>
              </div>
            </div>

            {/* Root Stake */}
            {rootPosition ? (
              <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-100">Root Stake</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      Staked TAO delegated to Root (netuid 0)
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-4">
                  <div>
                    <div className="text-xs text-zinc-400">Staked (TAO)</div>
                    <div className="mt-1 text-lg font-medium text-zinc-100">{rootPosition.valueTao}</div>
                    <div className="mt-1 text-xs text-zinc-500">{fmtUsdFromString(rootPosition.valueUsd)}</div>
                  </div>

                  <div>
                    <div className="text-xs text-zinc-400">Est. APY (1D)</div>
                    <div className="mt-1 text-lg font-medium text-zinc-100">
                      {fmtPct(rootPosition.apy?.oneDayPct)}
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      7D: {fmtPct(rootPosition.apy?.sevenDayPct)} • 30D:{" "}
                      {fmtPct(rootPosition.apy?.thirtyDayPct)}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-zinc-400">Realized APY</div>
                    <div className="mt-1 text-sm font-medium text-zinc-100">
                      1D: {fmtPctAny(rootRealized?.oneDayPct)}{" "}
                      <span className="text-zinc-600">•</span>{" "}
                      7D: {fmtPctAny(rootRealized?.sevenDayPct)}{" "}
                      <span className="text-zinc-600">•</span>{" "}
                      30D: {fmtPctAny(rootRealized?.thirtyDayPct)}
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      Based on snapshot deltas (TAO terms). Shows — until enough history exists.
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-zinc-400">NetUID</div>
                    <div className="mt-1 text-lg font-medium text-zinc-100">0</div>
                  </div>
                </div>
              </div>
            ) : null}

            {/* Subnet Positions */}
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
                <div className="mt-4 overflow-x-auto [-webkit-overflow-scrolling:touch]">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-zinc-500">
                      <tr>
                        <th className="py-2 pr-4">NetUID</th>
                        <th className="py-2 pr-4">Name</th>
                        <th className="py-2 pr-4">Alpha</th>
                        <th className="py-2 pr-4">Price (TAO)</th>
                        <th className="py-2 pr-4">Value (TAO)</th>
                        <th className="py-2 pr-4">Value (USD)</th>
                        <th className="py-2 pr-4">Est. APY (1D)</th>
                        <th className="py-2 pr-4">Est. APY (30D)</th>
                        <th className="py-2 pr-4">Realized APY (1D)</th>
                        <th className="py-2 pr-4">Realized APY (7D)</th>
                        <th className="py-2 pr-0">Realized APY (30D)</th>
                      </tr>
                    </thead>
                    <tbody className="text-zinc-200">
                      {subnetPositions.map((s) => {
                        const realized = getRealizedApy("subnet", s.netuid);

                        return (
                          <tr key={s.netuid} className="border-t border-zinc-800">
                            <td className="py-2 pr-4">{s.netuid}</td>
                            <td className="py-2 pr-4">
                              {s.name ? (
                                <span className="text-zinc-100">{s.name}</span>
                              ) : (
                                <span className="text-zinc-500">—</span>
                              )}
                            </td>
                            <td className="py-2 pr-4">{s.alphaBalance}</td>
                            <td className="py-2 pr-4">
                              {s.alphaPriceTao ? s.alphaPriceTao : <span className="text-zinc-500">—</span>}
                            </td>
                            <td className="py-2 pr-4">{s.valueTao}</td>
                            <td className="py-2 pr-4">{fmtUsdFromString(s.valueUsd)}</td>
                            <td className="py-2 pr-4">{fmtPct(s.apy?.oneDayPct)}</td>
                            <td className="py-2 pr-4">{fmtPct(s.apy?.thirtyDayPct)}</td>
                            <td className="py-2 pr-4">{fmtPctAny(realized?.oneDayPct)}</td>
                            <td className="py-2 pr-4">{fmtPctAny(realized?.sevenDayPct)}</td>
                            <td className="py-2 pr-0">{fmtPctAny(realized?.thirtyDayPct)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <div className="mt-3 text-xs text-zinc-500">
                    Price is implied as <span className="text-zinc-400">Value ÷ Alpha</span>. Estimated APY comes from
                    current network data; realized APY is based on stored snapshots (TAO terms).
                  </div>
                </div>
              )}
            </div>
          </>
        )}
       </div>
      </div>
    </main>
  );
}
