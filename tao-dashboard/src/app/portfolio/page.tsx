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

/** Snapshot alpha delta types (from stored snapshots) */
type AlphaDeltaPeriod = {
  periodStart: string;
  periodEnd: string;
  netuid: number;
  hotkey: string | null;
  alphaStart: string;
  alphaEnd: string;
  alphaEarned: string;
};

type AlphaDeltasResponse = {
  ok: boolean;
  hours?: number;
  periods?: AlphaDeltaPeriod[];
  error?: string;
};

type PerformanceSummaryResponse = {
  ok: boolean;
  days?: number;
  endCapturedAt?: string;

  kpis?: {
    startTotalTao: string;
    endTotalTao: string;
    deltaTao: string;
    returnTaoPct: string;

    startTotalUsd: string;
    endTotalUsd: string;
    deltaUsd: string;
    returnUsdPct: string;

    // NEW: both versions so the UI can choose
    alphaTaoImpactEstNet: string;
    alphaTaoImpactEstStaking: string;

    maxDrawdownPct: string;
  } | null;

  contributors?: Array<{
    netuid: number;
    hotkey: string | null;

    // NEW: both versions
    alphaEarnedNet: string;
    alphaEarnedStakingEst: string;

    taoImpactEstNet: string;
    taoImpactEstStaking: string;

    sharePctNet: string;
    sharePctStaking: string;

    flowLikelyPeriods: number;
  }>;

  daily?: Array<{
    periodEnd: string;
    deltaTao: string;
    returnPctTao: string;
  }>;

  error?: string;
};

type CronStatusResponse =
  | {
      ok: true;
      address: string;
      expectedCadence: "daily" | string;
      now: string;

      lastSnapshotAt: string | null;
      snapshotAgeDays: number | null;
      snapshotStale: boolean;

      coverageLast30: { expected: number; present: number; missing: number };
      missingDatesUtc: string[];
      streakDays: number;

      lastCronRun: {
        ranAt: string;
        ok: boolean;
        message: string | null;
        durationMs: number | null;
        snapshotsInserted: number | null;
        positionsInserted: number | null;
      } | null;
    }
  | {
      ok: false;
      error?: string;
    };

type Severity = "INFO" | "WARN" | "CRITICAL";

type Signal = {
  id: string;
  day: string;
  netuid?: number;
  severity: Severity;
  type: string;
  title: string;
  why: string;
  metrics?: Record<string, any>;
};

type SignalsResponse = {
  ok: boolean;
  day: string | null;
  signals: Array<{
    id: string;
    day: string;
    netuid?: number;
    severity: "INFO" | "WARN" | "CRITICAL";
    type: string;
    title: string;
    why: string;
    metrics?: Record<string, any>;
  }>;
  meta?: {
    partial?: boolean;
    missing?: string[];
    heldNetuids?: number[];
    note?: string;
  };
};

function sevRank(s: Severity): number {
  return s === "CRITICAL" ? 3 : s === "WARN" ? 2 : 1;
}

function sevStyles(s: Severity): { badge: string; dot: string; label: string } {
  if (s === "CRITICAL") {
    return {
      label: "Critical",
      badge: "border-red-500/30 bg-red-500/10 text-red-200",
      dot: "bg-red-400",
    };
  }
  if (s === "WARN") {
    return {
      label: "Warn",
      badge: "border-amber-500/30 bg-amber-500/10 text-amber-200",
      dot: "bg-amber-300",
    };
  }
  return {
    label: "Info",
    badge: "border-sky-500/30 bg-sky-500/10 text-sky-200",
    dot: "bg-sky-300",
  };
}

function groupSignalsByNetuid(signals: Signal[]): Array<{
  netuid: number | null;
  worst: Severity;
  signals: Signal[];
}> {
  const m = new Map<string, Signal[]>();

  for (const s of signals) {
    const key = s.netuid == null ? "portfolio" : String(s.netuid);
    const arr = m.get(key) ?? [];
    arr.push(s);
    m.set(key, arr);
  }

  const groups: Array<{ netuid: number | null; worst: Severity; signals: Signal[] }> = [];

  for (const [key, arr] of m.entries()) {
    // Sort signals within group: severity desc, then title
    arr.sort((a, b) => {
      const d = sevRank(b.severity) - sevRank(a.severity);
      if (d !== 0) return d;
      return a.title.localeCompare(b.title);
    });

    const worst = arr[0]?.severity ?? "INFO";
    groups.push({
      netuid: key === "portfolio" ? null : Number(key),
      worst,
      signals: arr,
    });
  }

  // Sort groups: worst severity desc, then netuid asc (portfolio group first if critical)
  groups.sort((a, b) => {
    const d = sevRank(b.worst) - sevRank(a.worst);
    if (d !== 0) return d;
    if (a.netuid == null) return -1;
    if (b.netuid == null) return 1;
    return a.netuid - b.netuid;
  });

  return groups;
}


async function getCronStatus(): Promise<CronStatusResponse> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/cron/status`, { cache: "no-store" });
    return (await res.json()) as CronStatusResponse;
  } catch {
    return { ok: false, error: "Failed to fetch cron status." };
  }
}

async function getPerformanceSummary(days = 30): Promise<PerformanceSummaryResponse> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/portfolio/performance?days=${days}`, { cache: "no-store" });
    return (await res.json()) as PerformanceSummaryResponse;
  } catch {
    return { ok: false, error: "Failed to fetch performance summary." };
  }
}

function getBaseUrl() {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;

  if (process.env.NODE_ENV === "development") return "http://localhost:3000";
  throw new Error("Missing base URL (set NEXT_PUBLIC_BASE_URL in Vercel).");
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


async function getAlphaDeltas(hours = 48): Promise<AlphaDeltasResponse> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/portfolio/alpha-deltas?hours=${hours}`, { cache: "no-store" });
    return (await res.json()) as AlphaDeltasResponse;
  } catch {
    return { ok: false, periods: [], error: "Failed to fetch alpha deltas." };
  }
}

async function getSignals(): Promise<SignalsResponse> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/portfolio/signals`, { cache: "no-store" });
    return (await res.json()) as SignalsResponse;
  } catch {
    return { ok: false, day: null, signals: [], meta: { partial: true, missing: ["Failed to fetch signals"] } };
  }
}


function toNum(x: string | undefined | null): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Formats a TAO-denominated numeric value to exactly 4 decimal places.
 * - Fail-soft: returns "—" if missing/NaN
 * - Keeps trailing zeros for consistent table alignment (e.g., 1.2000)
 */
function fmtTao4FromString(s?: string | null): string {
  if (s == null) return "—";
  const n = Number(s);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(4);
}

/**
 * Formats a TAO-denominated numeric value to exactly 4 decimal places.
 * - Use when you already have a number
 */
function fmtTao4(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(4);
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

function fmtPeriodEnd(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;

  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Chicago",
    hour12: true,
  }).format(d);
}

function fmtEarnedPct(alphaEarnedStr: string, alphaStartStr: string): string {
  const earned = Number(alphaEarnedStr);
  const start = Number(alphaStartStr);

  if (!Number.isFinite(earned) || !Number.isFinite(start) || start <= 0) return "—";

  const pct = (earned / start) * 100;
  return `${pct.toFixed(2)}%`;
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

function fmtSignedPct4(s?: string): string {
  const n = Number(s);
  if (!Number.isFinite(n) || s === "") return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtSignedTao4FromString(s?: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(4)}`;
}


function makeHistoryKey(positionType: "root" | "subnet", netuid: number, hotkey: string | null) {
  // Root uses hotkey = null. Keep it explicit for deterministic keys.
  return `${positionType}:${netuid}:${hotkey ?? ""}`;
}

export default async function PortfolioPage() {
  const [data, nameMap, history, alphaDeltas, perf, cron, signalsRes] = await Promise.all([
    getPortfolio(),
    getSubnetNames(),
    getPortfolioHistory(),
    getAlphaDeltas(30 * 24),
    getPerformanceSummary(30),
    getCronStatus(),
    getSignals(),
  ]);


  // Build realized APY lookup keyed by "positionType:netuid:hotkey"
  const realizedApyByKey = new Map<string, HistoryPosition["apy"]>();
  if (history?.ok && Array.isArray(history.positions)) {
    for (const p of history.positions) {
      const key = makeHistoryKey(p.positionType, p.netuid, p.hotkey);
      realizedApyByKey.set(key, p.apy);
    }
  }

  const getRealizedApy = (positionType: "root" | "subnet", netuid: number, hotkey: string | null) => {
    const key = makeHistoryKey(positionType, netuid, hotkey);
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

  const rootRealized = getRealizedApy("root", 0, null);

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

      const alphaPriceTao = s.alphaPriceTao?.trim() ? s.alphaPriceTao : fmtPriceTao(impliedPriceTao);

      return {
        ...s,
        name,
        alphaPriceTao,
        hotkey: s.hotkey ?? null,
      };
    });

  const totalValueUsd = fmtUsdFromString(data?.totals?.totalValueUsd);

  // If totals.totalValueUsd ever goes missing, compute it
  const computedTotalUsd =
    !data?.totals?.totalValueUsd && taoUsd > 0 ? fmtUsd(toNum(data?.totals?.totalValueTao) * taoUsd) : null;

  return (
    <main className="min-h-screen">
      <div className="p-4 sm:p-6">
        <div className="mx-auto w-full max-w-5xl">
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Portfolio</h1>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-300">
                  TAO Dashboard
                </span>
              </div>

              <p className="mt-1 text-sm text-zinc-400">
                Read-only wallet view (TAO + subnet tokens). Updated:{" "}
                <span className="text-zinc-300">{data.updatedAt}</span>
              </p>

              <p className="mt-1 text-xs text-zinc-500 break-all">Address: {data.address}</p>

              <p className="mt-1 text-xs text-zinc-600">
                TAO/USD: <span className="text-zinc-400">{taoUsd > 0 ? fmtUsd(taoUsd) : "—"}</span>
                {data?.pricing?.source ? <span className="text-zinc-600">{" "}• source: {data.pricing.source}</span> : null}
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
                    {data.totals.totalValueTao} <span className="text-sm font-normal text-zinc-400">TAO</span>
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
                    <span className="text-zinc-600">{" "}• root: {fmtPct(data?.apySummary?.root?.oneDayPct)}</span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    7D: {fmtPct(data?.apySummary?.subnets?.sevenDayPct)} • 30D: {fmtPct(data?.apySummary?.subnets?.thirtyDayPct)}
                  </div>
                </div>
              </div>


              {/* Root Stake */}
              {rootPosition ? (
                <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-zinc-100">Root Stake</div>
                      <div className="mt-1 text-xs text-zinc-500">Staked TAO delegated to Root (netuid 0)</div>
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
                      <div className="mt-1 text-lg font-medium text-zinc-100">{fmtPct(rootPosition.apy?.oneDayPct)}</div>
                      <div className="mt-1 text-xs text-zinc-500">
                        7D: {fmtPct(rootPosition.apy?.sevenDayPct)} • 30D: {fmtPct(rootPosition.apy?.thirtyDayPct)}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-zinc-400">Realized APY</div>
                      <div className="mt-1 text-sm font-medium text-zinc-100">
                        1D: {fmtPctAny(rootRealized?.oneDayPct)} <span className="text-zinc-600">•</span>{" "}
                        7D: {fmtPctAny(rootRealized?.sevenDayPct)} <span className="text-zinc-600">•</span>{" "}
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
                  <>
                    {/* Mobile card list */}
                    <div className="mt-4 space-y-3 sm:hidden">
                      {subnetPositions.map((s) => {
                        const realized = getRealizedApy("subnet", s.netuid, s.hotkey ?? null);

                        return (
                          <div
                            key={`${s.netuid}:${s.hotkey ?? ""}`}
                            className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold text-gray-100">{s.name || `Subnet ${s.netuid}`}</div>
                                <div className="mt-1 text-xs text-gray-400">
                                  NetUID: <span className="tabular-nums text-gray-200">{s.netuid}</span>
                                </div>
                              </div>

                              <div className="text-right">
                                <div className="text-xs text-gray-400">Value (USD)</div>
                                <div className="text-sm font-semibold text-gray-100">{fmtUsdFromString(s.valueUsd)}</div>
                              </div>
                            </div>

                            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                                <div className="text-gray-400">Value (TAO)</div>
                                <div className="mt-1 font-semibold tabular-nums text-gray-200">
                                  {fmtTao4FromString(s.valueTao)}
                                </div>
                              </div>

                              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                                <div className="text-gray-400">Alpha</div>
                                <div className="mt-1 font-semibold tabular-nums text-gray-200">
                                  {fmtTao4FromString(s.alphaBalance)}
                                </div>
                              </div>

                              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                                <div className="text-gray-400">Price (TAO)</div>
                                <div className="mt-1 font-semibold tabular-nums text-gray-200">
                                  {s.alphaPriceTao ? fmtTao4FromString(s.alphaPriceTao) : "—"}
                                </div>
                              </div>

                              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                                <div className="text-gray-400">Est. APY (30D)</div>
                                <div className="mt-1 font-semibold tabular-nums text-gray-200">{fmtPct(s.apy?.thirtyDayPct)}</div>
                              </div>

                              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                                <div className="text-gray-400">Realized APY (1D)</div>
                                <div className="mt-1 font-semibold tabular-nums text-gray-200">{fmtPctAny(realized?.oneDayPct)}</div>
                              </div>

                              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                                <div className="text-gray-400">Realized APY (30D)</div>
                                <div className="mt-1 font-semibold tabular-nums text-gray-200">{fmtPctAny(realized?.thirtyDayPct)}</div>
                              </div>
                            </div>

                            <div className="mt-3 text-[11px] text-gray-500">
                              Realized APY is based on stored snapshots (TAO terms). Shows — until enough history exists.
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Desktop table */}
                    <div className="mt-4 hidden overflow-x-auto [-webkit-overflow-scrolling:touch] sm:block">
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
                            const realized = getRealizedApy("subnet", s.netuid, s.hotkey ?? null);

                            return (
                              <tr key={`${s.netuid}:${s.hotkey ?? ""}`} className="border-t border-zinc-800">
                                <td className="py-2 pr-4">{s.netuid}</td>
                                <td className="py-2 pr-4">
                                  {s.name ? <span className="text-zinc-100">{s.name}</span> : <span className="text-zinc-500">—</span>}
                                </td>
                                <td className="py-2 pr-4">{fmtTao4FromString(s.alphaBalance)}</td>
                                <td className="py-2 pr-4">
                                  {s.alphaPriceTao ? fmtTao4FromString(s.alphaPriceTao) : <span className="text-zinc-500">—</span>}
                                </td>
                                <td className="py-2 pr-4">{fmtTao4FromString(s.valueTao)}</td>
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
                        Price is implied as <span className="text-zinc-400">Value ÷ Alpha</span>. Estimated APY comes from current
                        network data; realized APY is based on stored snapshots (TAO terms).
                      </div>
                    </div>
                  </>
                )}
              </div>


              {/* Performance Summary */}
              <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-100">Performance Summary</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      Last 30 days • Snapshot-driven • Alpha values are staking-estimated (flow-filtered)
                    </div>
                  </div>
                  <div className="text-xs text-zinc-500">{perf?.ok ? "Loaded" : "Unavailable"}</div>
                </div>

                {!perf?.ok || !perf?.kpis ? (
                  <div className="mt-4 text-sm text-zinc-400">
                    Could not load performance summary:{" "}
                    <span className="text-zinc-500">{perf?.error ?? "Unknown error"}</span>
                  </div>
                ) : (
                  <>
                    {/* KPI row */}
                    <div className="mt-4 grid gap-4 sm:grid-cols-4">
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="text-xs text-zinc-400">Return (TAO)</div>
                        <div className="mt-2 text-lg font-semibold text-zinc-100">
                          {fmtSignedPct4(perf.kpis.returnTaoPct)}
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">
                          Δ TAO:{" "}
                          <span className="text-zinc-300 tabular-nums">
                            {fmtSignedTao4FromString(perf.kpis.deltaTao)}
                          </span>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="text-xs text-zinc-400">Return (USD)</div>
                        <div className="mt-2 text-lg font-semibold text-zinc-100">
                          {fmtSignedPct4(perf.kpis.returnUsdPct)}
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">
                          Δ USD:{" "}
                          <span className="text-zinc-300 tabular-nums">
                            {fmtUsd(Number(perf.kpis.deltaUsd))}
                          </span>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="text-xs text-zinc-400">Alpha Impact (staking est.)</div>
                        <div className="mt-2 text-lg font-semibold text-zinc-100 tabular-nums">
                          {fmtSignedTao4FromString(perf.kpis.alphaTaoImpactEstStaking)}{" "}
                          <span className="text-xs font-normal text-zinc-400">TAO</span>
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">
                          Sum(alpha Δ × end-period price), excluding flow-like spikes
                        </div>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="text-xs text-zinc-400">Max Drawdown (TAO)</div>
                        <div className="mt-2 text-lg font-semibold text-zinc-100">
                          {perf.kpis.maxDrawdownPct ? `${Number(perf.kpis.maxDrawdownPct).toFixed(2)}%` : "—"}
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">Worst peak → trough</div>
                      </div>
                    </div>

                    {/* Top contributors */}
                    <div className="mt-5">
                      <div className="text-xs text-zinc-400">Top Subnet Contributors (staking-est TAO impact)</div>

                      {(perf.contributors ?? []).length === 0 ? (
                        <div className="mt-2 text-sm text-zinc-400">No contributor data yet.</div>
                      ) : (
                        <div className="mt-2 overflow-x-auto [-webkit-overflow-scrolling:touch]">
                          <table className="w-full text-left text-sm">
                            <thead className="text-xs text-zinc-500">
                              <tr>
                                <th className="py-2 pr-4">NetUID</th>
                                <th className="py-2 pr-4">Name</th>
                                <th className="py-2 pr-4">Alpha Earned (est.)</th>
                                <th className="py-2 pr-4">TAO Impact (est.)</th>
                                <th className="py-2 pr-4">Share</th>
                                <th className="py-2 pr-0">Flow Exclusions</th>
                              </tr>
                            </thead>

                            <tbody className="text-zinc-200">
                              {(perf.contributors ?? []).slice(0, 12).map((c) => {
                                const name = nameMap.get(c.netuid) ?? `Subnet ${c.netuid}`;
                                const share = Number(c.sharePctStaking);
                                const flowExclusions = c.flowLikelyPeriods;

                                return (
                                  <tr key={`${c.netuid}:${c.hotkey ?? ""}`} className="border-t border-zinc-800">
                                    <td className="py-2 pr-4 tabular-nums">{c.netuid}</td>
                                    <td className="py-2 pr-4 text-zinc-100">{name}</td>
                                    <td className="py-2 pr-4 tabular-nums">{fmtTao4FromString(c.alphaEarnedStakingEst)}</td>
                                    <td className="py-2 pr-4 tabular-nums">{fmtSignedTao4FromString(c.taoImpactEstStaking)}</td>
                                    <td className="py-2 pr-4 tabular-nums">{Number.isFinite(share) ? share.toFixed(1) : "—"}%</td>
                                    <td className="py-2 pr-0 tabular-nums">
                                      {flowExclusions > 0 ? flowExclusions : <span className="text-zinc-500">—</span>}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>

                          <div className="mt-2 text-xs text-zinc-500">
                            “Staking est.” excludes periods where alpha increased unusually fast (likely purchases/rebalances). Net changes are still stored in the DB; this is just a filtered view.
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>


              {/* Cron Health */}
              <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-100">Cron Health</div>
                    <div className="mt-1 text-xs text-zinc-500">Daily snapshot ingestion</div>
                  </div>

                  <div
                    className={[
                      "text-xs rounded-full px-2 py-1 border",
                      !cron?.ok
                        ? "border-white/10 bg-white/5 text-zinc-500"
                        : cron.snapshotStale
                        ? "border-red-500/30 bg-red-500/10 text-red-200"
                        : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
                    ].join(" ")}
                  >
                    {!cron?.ok ? "Unavailable" : cron.snapshotStale ? "Stale" : "Live"}
                  </div>
                </div>

                {!cron?.ok ? (
                  <div className="mt-4 text-sm text-zinc-400">
                    Could not load cron status{cron?.error ? (
                      <>
                        : <span className="text-zinc-500">{cron.error}</span>
                      </>
                    ) : (
                      "."
                    )}
                  </div>
                ) : (
                  <div className="mt-4 grid gap-4 sm:grid-cols-3">
                    <div>
                      <div className="text-xs text-zinc-400">Last Snapshot</div>
                      <div className="mt-1 text-sm text-zinc-100 tabular-nums">
                        {cron.lastSnapshotAt ? (
                          <div className="space-y-0.5">
                            <div className="text-zinc-100 tabular-nums">
                              {new Date(cron.lastSnapshotAt).toLocaleString()}
                            </div>
                            <div className="text-[11px] text-zinc-500 tabular-nums">
                              UTC: {new Date(cron.lastSnapshotAt).toISOString().replace(".000Z", "Z")}
                            </div>
                          </div>
                        ) : (
                          "—"
                        )}

                      </div>
                      <div className="mt-1 text-xs text-zinc-500">
                        Age:{" "}
                        <span className={cron.snapshotStale ? "text-red-300" : "text-zinc-300"}>
                          {cron.snapshotAgeDays != null ? `${cron.snapshotAgeDays.toFixed(2)} days` : "—"}
                        </span>
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-zinc-400">Coverage (30d)</div>
                      <div className="mt-1 text-sm text-zinc-100 tabular-nums">
                        {cron.coverageLast30
                          ? `${cron.coverageLast30.present}/${cron.coverageLast30.expected} days`
                          : "—"}
                      </div>
                      <div className="mt-1 text-xs text-zinc-500">
                        Missing:{" "}
                        <span className="tabular-nums">
                          {cron.coverageLast30 ? cron.coverageLast30.missing : "—"}
                        </span>
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-zinc-400">Streak</div>
                      <div className="mt-1 text-sm text-zinc-100 tabular-nums">
                        {cron.streakDays != null ? `${cron.streakDays} days` : "—"}
                      </div>
                      <div className="mt-1 text-xs text-zinc-500">
                        Last run:{" "}
                        <span className="tabular-nums">
                          {cron.lastCronRun?.ranAt ? new Date(cron.lastCronRun.ranAt).toLocaleString() : "—"}
                        </span>
                      </div>
                    </div>

                    {(cron.missingDatesUtc?.length ?? 0) > 0 ? (
                      <div className="sm:col-span-3">
                        <div className="text-xs text-zinc-400">Missing dates (UTC)</div>
                        <div className="mt-1 text-xs text-zinc-500">
                          {(cron.missingDatesUtc ?? []).join(", ")}
                        </div>
                      </div>
                    ) : null}

                    <div className="sm:col-span-3 mt-3 text-[11px] text-zinc-500">
                      Cron Health is derived from stored snapshots using <span className="text-zinc-400">UTC-day bucketing</span>.
                      Local times are shown for convenience only.
                    </div>

                  </div>
                )}
              </div>


              {/* Signals / Notifications (grouped by subnet) */}
              <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-zinc-100">Signals</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      Daily, snapshot-driven alerts for held subnets.
                      {signalsRes?.ok && signalsRes.day ? (
                        <span className="text-zinc-600"> • day (UTC): {signalsRes.day}</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="text-xs text-zinc-500">
                    {signalsRes?.ok ? `${(signalsRes.signals ?? []).length} signal(s)` : "Unavailable"}
                  </div>
                </div>

                {!signalsRes?.ok ? (
                  <div className="mt-4 text-sm text-zinc-400">
                    Could not load signals{" "}
                    <span className="text-zinc-500">
                      {signalsRes?.meta?.missing?.[0] ? `(${signalsRes.meta.missing[0]})` : ""}
                    </span>
                  </div>
                ) : (signalsRes.signals ?? []).length === 0 ? (
                  <div className="mt-4 text-sm text-zinc-400">
                    No signals triggered for today.
                    {signalsRes?.meta?.note ? (
                      <div className="mt-1 text-xs text-zinc-500">{signalsRes.meta.note}</div>
                    ) : null}
                  </div>
                ) : (
                  <>
                    {/* Counts row */}
                    {(() => {
                      const sigs = signalsRes.signals ?? [];
                      const counts = sigs.reduce(
                        (acc, s) => {
                          if (s.severity === "CRITICAL") acc.critical++;
                          else if (s.severity === "WARN") acc.warn++;
                          else acc.info++;
                          return acc;
                        },
                        { critical: 0, warn: 0, info: 0 }
                      );

                      return (
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-200">
                            {counts.critical} critical
                          </span>
                          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200">
                            {counts.warn} warn
                          </span>
                          <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-blue-200">
                            {counts.info} info
                          </span>

                          {signalsRes?.meta?.note ? (
                            <span className="ml-1 text-zinc-500">{signalsRes.meta.note}</span>
                          ) : null}
                        </div>
                      );
                    })()}

                    {/* Partial-data banner */}
                    {signalsRes?.meta?.partial ? (
                      <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                        Partial data:{" "}
                        <span className="text-amber-100">
                          {(signalsRes.meta?.missing ?? []).slice(0, 6).join(" • ")}
                          {(signalsRes.meta?.missing?.length ?? 0) > 6 ? " • …" : ""}
                        </span>
                      </div>
                    ) : null}

                    {/* Grouped cards */}
                    <div className="mt-4 space-y-3">
                      {groupSignalsByNetuid(signalsRes.signals ?? []).map((g) => {
                        const worst = sevStyles(g.worst);
                        const groupName =
                          g.netuid == null ? "Portfolio" : nameMap.get(g.netuid) ?? `Subnet ${g.netuid}`;

                        return (
                          <div
                            key={`signals:${g.netuid ?? "portfolio"}`}
                            className="rounded-2xl border border-white/10 bg-white/5 p-4"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className={`h-2.5 w-2.5 rounded-full ${worst.dot}`} />
                                  <div className="text-sm font-semibold text-zinc-100">
                                    {groupName}
                                    {g.netuid != null ? (
                                      <span className="text-xs font-normal text-zinc-500"> • netuid {g.netuid}</span>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="mt-1 text-xs text-zinc-500">{g.signals.length} alert(s)</div>
                              </div>

                              <span className={["text-xs rounded-full px-2 py-1 border", worst.badge].join(" ")}>
                                {worst.label}
                              </span>
                            </div>

                            <div className="mt-3 space-y-2">
                              {g.signals.slice(0, 4).map((s) => {
                                const st = sevStyles(s.severity);

                                return (
                                  <div key={s.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="text-sm text-zinc-100">{s.title}</div>
                                      <span
                                        className={["text-[11px] rounded-full px-2 py-0.5 border", st.badge].join(" ")}
                                      >
                                        {st.label}
                                      </span>
                                    </div>
                                    <div className="mt-1 text-xs text-zinc-500">{s.why}</div>
                                  </div>
                                );
                              })}

                              {g.signals.length > 4 ? (
                                <div className="text-xs text-zinc-500">+{g.signals.length - 4} more…</div>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Full table (desktop) */}
                    <div className="mt-5 hidden overflow-x-auto [-webkit-overflow-scrolling:touch] sm:block">
                      <table className="w-full text-left text-sm">
                        <thead className="text-xs text-zinc-500">
                          <tr>
                            <th className="py-2 pr-4">Severity</th>
                            <th className="py-2 pr-4">NetUID</th>
                            <th className="py-2 pr-4">Name</th>
                            <th className="py-2 pr-0">Message</th>
                          </tr>
                        </thead>

                        <tbody className="text-zinc-200">
                          {(signalsRes.signals ?? []).slice(0, 100).map((s) => {
                            const sevClass =
                              s.severity === "CRITICAL"
                                ? "text-red-200"
                                : s.severity === "WARN"
                                ? "text-amber-200"
                                : "text-blue-200";

                            const name = s.netuid != null ? nameMap.get(s.netuid) ?? `Subnet ${s.netuid}` : "Portfolio";

                            return (
                              <tr key={s.id} className="border-t border-zinc-800">
                                <td className={`py-2 pr-4 text-xs font-semibold ${sevClass}`}>{s.severity}</td>
                                <td className="py-2 pr-4 tabular-nums">
                                  {s.netuid != null ? s.netuid : <span className="text-zinc-500">—</span>}
                                </td>
                                <td className="py-2 pr-4 text-zinc-100">{name}</td>
                                <td className="py-2 pr-0">
                                  <div className="text-zinc-100">{s.title}</div>
                                  <div className="mt-0.5 text-xs text-zinc-400">{s.why}</div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>

                      <div className="mt-2 text-xs text-zinc-500">
                        V1 signals are informational and snapshot-driven. Expect more accurate baselines after ~14 days of history.
                      </div>
                    </div>
                  </>
                )}
              </div>
  


              {/* Snapshot Alpha Earned (from stored snapshots) */}
              <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-100">Snapshot Alpha Earned</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      Daily snapshot deltas (alpha change per subnet position between consecutive snapshots).
                    </div>
                  </div>

                  <div className="text-xs text-zinc-500">
                    {alphaDeltas?.ok
                      ? `Last ${Math.round((alphaDeltas.hours ?? 720) / 24)} days`
                       : "Unavailable"}

                  </div>
                </div>

                {!alphaDeltas?.ok ? (
                  <div className="mt-4 text-sm text-zinc-400">
                    Could not load snapshot deltas:{" "}
                    <span className="text-zinc-500">{alphaDeltas?.error ?? "Unknown error"}</span>
                  </div>
                ) : (alphaDeltas.periods ?? []).length === 0 ? (
                  <div className="mt-4 text-sm text-zinc-400">No snapshot deltas yet (need at least 2 snapshots).</div>
                ) : (
                  <div className="mt-4 overflow-x-auto [-webkit-overflow-scrolling:touch]">
                    <table className="w-full text-left text-sm">
                      <thead className="text-xs text-zinc-500">
                        <tr>
                          <th className="py-2 pr-4">Period End</th>
                          <th className="py-2 pr-4">NetUID</th>
                          <th className="py-2 pr-4">Name</th>
                          <th className="py-2 pr-4">Alpha Start</th>
                          <th className="py-2 pr-4">Alpha End</th>
                          <th className="py-2 pr-4">Alpha Earned</th>
                          <th className="py-2 pr-0">% Earned</th>
                        </tr>
                      </thead>

                      <tbody className="text-zinc-200">
                        {(alphaDeltas.periods ?? []).slice(0, 200).map((p) => {
                          const name = nameMap.get(p.netuid) ?? `Subnet ${p.netuid}`;

                          return (
                            <tr key={`${p.periodEnd}:${p.netuid}:${p.hotkey ?? ""}`} className="border-t border-zinc-800">
                              <td className="py-2 pr-4 text-xs text-zinc-400 tabular-nums">{fmtPeriodEnd(p.periodEnd)}</td>
                              <td className="py-2 pr-4 tabular-nums">{p.netuid}</td>
                              <td className="py-2 pr-4">
                                <span className="text-zinc-100">{name}</span>
                              </td>
                              <td className="py-2 pr-4 tabular-nums">{fmtTao4FromString(p.alphaStart)}</td>
                              <td className="py-2 pr-4 tabular-nums">{fmtTao4FromString(p.alphaEnd)}</td>
                              <td className="py-2 pr-4 tabular-nums">{fmtTao4FromString(p.alphaEarned)}</td>
                              <td className="py-2 pr-0 tabular-nums">{fmtEarnedPct(p.alphaEarned, p.alphaStart)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    <div className="mt-3 text-xs text-zinc-500">
                      This view is purely derived from stored snapshots. Negative values are possible during rebalances or stake
                      moves.
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
