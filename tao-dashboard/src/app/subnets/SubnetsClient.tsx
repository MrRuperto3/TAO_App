"use client";

import { useMemo, useState } from "react";
import { formatCompact, formatInt } from "@/lib/format";

type Subnet = {
  netuid: number;
  name: string | null;

  emission: string;
  emissionPct: string; // percent of total emissions (e.g. "0.412345")
  subnetTAO: string;
  subnetTaoFlow: string;
  subnetTaoFlowDir: "up" | "down" | "flat";
  subnetEmaTaoFlow: string;
  subnetEmaTaoFlowDir: "up" | "down" | "flat";
  subnetMovingPrice: string;
};

type SortKey =
  | "netuid_asc"
  | "name_asc"
  | "tao_desc"
  | "emission_desc"
  | "flow_desc"
  | "ema_flow_desc"
  | "price_desc"
  | "yield_desc";

type Momentum = "bullish" | "neutral" | "bearish";
type Yield = "high" | "mid" | "low";
type Risk = "lower" | "normal" | "higher";

type Signals = {
  momentum: Momentum;
  yield: Yield;
  risk: Risk;
  yieldPerBlock: number; // emission/subnetTAO
};

type MomentumFilter = Momentum | "any";
type YieldFilter = "high" | "mid" | "low" | "any";
type RiskFilter = Risk | "any";

function Arrow({ dir }: { dir: "up" | "down" | "flat" }) {
  if (dir === "up") return <span className="text-green-400">↑</span>;
  if (dir === "down") return <span className="text-red-400">↓</span>;
  return <span className="text-gray-400">→</span>;
}

function Stat({
  label,
  value,
  right,
}: {
  label: string;
  value: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-black/20 px-2 py-1">
      <span className="text-sm text-gray-400">{label}</span>
      <span className="text-sm font-medium text-gray-100 tabular-nums text-right">
        {value} {right}
      </span>
    </div>
  );
}

function Chip({
  label,
  tone,
  tooltip,
}: {
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
  tooltip: string;
}) {
  const cls =
    tone === "good"
      ? "bg-green-500/15 text-green-200 border-green-500/25"
      : tone === "warn"
      ? "bg-yellow-500/15 text-yellow-200 border-yellow-500/25"
      : tone === "bad"
      ? "bg-red-500/15 text-red-200 border-red-500/25"
      : "bg-white/10 text-gray-200 border-white/10";

  return (
    <span className="relative group inline-flex">
      <span
        className={`cursor-help rounded-full border px-2 py-0.5 text-[11px] ${cls}`}
      >
        {label}
      </span>
      <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-56 -translate-x-1/2 rounded-lg border border-white/10 bg-black/90 px-3 py-2 text-xs text-gray-200 opacity-0 transition-opacity group-hover:opacity-100">
        {tooltip}
      </span>
    </span>
  );
}

function toNum(v: string) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function formatPct(pctStr: string, decimals = 2) {
  const n = Number.parseFloat(pctStr);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(decimals)}%`;
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  );
  return sorted[idx];
}

function computeSignals(subnets: Subnet[]): Map<number, Signals> {
  const ema = subnets.map((s) => toNum(s.subnetEmaTaoFlow));
  const yields = subnets.map(
    (s) => toNum(s.emission) / Math.max(1e-9, toNum(s.subnetTAO))
  );
  const prices = subnets.map((s) => toNum(s.subnetMovingPrice));
  const taos = subnets.map((s) => toNum(s.subnetTAO));

  const ema25 = percentile(ema, 0.25);
  const ema75 = percentile(ema, 0.75);
  const y25 = percentile(yields, 0.25);
  const y75 = percentile(yields, 0.75);
  const p75 = percentile(prices, 0.75);
  const t25 = percentile(taos, 0.25);
  const t75 = percentile(taos, 0.75);

  const out = new Map<number, Signals>();

  subnets.forEach((s, i) => {
    const momentum: Momentum =
      ema[i] >= ema75 ? "bullish" : ema[i] <= ema25 ? "bearish" : "neutral";

    const yieldTag: Yield =
      yields[i] >= y75 ? "high" : yields[i] <= y25 ? "low" : "mid";

    const tao = taos[i];
    const price = prices[i];

    const thin = tao <= t25;
    const crowded = tao >= t75;
    const overheated = price >= p75;

    let risk: Risk = "normal";
    if (thin || overheated) risk = "higher";
    if (crowded && !overheated) risk = "lower";

    out.set(s.netuid, { momentum, yield: yieldTag, risk, yieldPerBlock: yields[i] });
  });

  return out;
}

function matchesQuery(s: Subnet, qRaw: string) {
  const q = qRaw.trim().toLowerCase();
  if (!q) return true;

  const qNetuid = q.replace(/^sn/i, "").replace(/^#/, "");
  const netuidStr = String(s.netuid);
  const name = (s.name ?? "").toLowerCase();

  return (
    netuidStr.includes(qNetuid) || `sn${netuidStr}`.includes(q) || name.includes(q)
  );
}

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: "netuid_asc", label: "Netuid (asc)" },
  { value: "name_asc", label: "Name (A → Z)" },
  { value: "tao_desc", label: "Subnet TAO (desc)" },
  { value: "emission_desc", label: "Emission (desc)" },
  { value: "flow_desc", label: "TAO Flow (desc)" },
  { value: "ema_flow_desc", label: "EMA TAO Flow (desc)" },
  { value: "price_desc", label: "Moving price (desc)" },
  { value: "yield_desc", label: "Yield (desc)" },
];

export default function SubnetsClient({ subnets }: { subnets: Subnet[] }) {
  const [query, setQuery] = useState("");
  const [showSignals, setShowSignals] = useState(true);
  const [sort, setSort] = useState<SortKey>("emission_desc");

  // NEW: signal filters
  const [momentumFilter, setMomentumFilter] = useState<MomentumFilter>("any");
  const [yieldFilter, setYieldFilter] = useState<YieldFilter>("any");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("any");

  const signals = useMemo(() => computeSignals(subnets), [subnets]);

  const filteredAndSorted = useMemo(() => {
    const getYield = (s: Subnet) => signals.get(s.netuid)?.yieldPerBlock ?? 0;

    const filtered = subnets
      .filter((s) => matchesQuery(s, query))
      .filter((s) => {
        const sig = signals.get(s.netuid);
        if (!sig) return false;

        if (momentumFilter !== "any" && sig.momentum !== momentumFilter) return false;
        if (yieldFilter !== "any" && sig.yield !== yieldFilter) return false;
        if (riskFilter !== "any" && sig.risk !== riskFilter) return false;

        return true;
      });

    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "netuid_asc":
          return a.netuid - b.netuid;
        case "name_asc":
          return (a.name ?? "").localeCompare(b.name ?? "");
        case "tao_desc":
          return toNum(b.subnetTAO) - toNum(a.subnetTAO);
        case "emission_desc":
          return toNum(b.emission) - toNum(a.emission);
        case "flow_desc":
          return toNum(b.subnetTaoFlow) - toNum(a.subnetTaoFlow);
        case "ema_flow_desc":
          return toNum(b.subnetEmaTaoFlow) - toNum(a.subnetEmaTaoFlow);
        case "price_desc":
          return toNum(b.subnetMovingPrice) - toNum(a.subnetMovingPrice);
        case "yield_desc":
          return getYield(b) - getYield(a);
        default:
          return 0;
      }
    });
  }, [subnets, query, sort, signals, momentumFilter, yieldFilter, riskFilter]);

  return (
    <div className="mt-6">
      {/* Controls */}
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex-1">
            <label className="text-sm text-gray-400" htmlFor="subnetSearch">
              Search by subnet name or netuid (e.g.{" "}
              <span className="tabular-nums">SN2</span>,{" "}
              <span className="tabular-nums">2</span>, dsperse)
            </label>
            <input
              id="subnetSearch"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-100 placeholder:text-gray-500 outline-none focus:ring-2 focus:ring-white/20"
            />
          </div>

          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <input
                id="showSignals"
                type="checkbox"
                checked={showSignals}
                onChange={(e) => setShowSignals(e.target.checked)}
                className="h-4 w-4 accent-white"
              />
              <label htmlFor="showSignals" className="text-sm text-gray-200 select-none">
                Show signals
              </label>
            </div>

            <div>
              <label className="text-sm text-gray-400" htmlFor="subnetSort">
                Sort
              </label>
              <select
                id="subnetSort"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="mt-2 w-full sm:w-56 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-white/20"
              >
                {sortOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="text-sm text-gray-400 sm:pb-2">
              Showing{" "}
              <span className="font-semibold tabular-nums text-gray-100">
                {filteredAndSorted.length}
              </span>{" "}
              / <span className="tabular-nums">{subnets.length}</span>
            </div>
          </div>
        </div>

        {/* NEW: Signal Filters */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-sm font-semibold text-gray-200 mb-3">Signal filters</div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-sm text-gray-400" htmlFor="momentumFilter">
                Momentum
              </label>
              <select
                id="momentumFilter"
                value={momentumFilter}
                onChange={(e) => setMomentumFilter(e.target.value as MomentumFilter)}
                className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-white/20"
              >
                <option value="any">Any</option>
                <option value="bullish">Bullish</option>
                <option value="neutral">Neutral</option>
                <option value="bearish">Bearish</option>
              </select>
            </div>

            <div>
              <label className="text-sm text-gray-400" htmlFor="yieldFilter">
                Yield
              </label>
              <select
                id="yieldFilter"
                value={yieldFilter}
                onChange={(e) => setYieldFilter(e.target.value as YieldFilter)}
                className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-white/20"
              >
                <option value="any">Any</option>
                <option value="high">High</option>
                <option value="mid">Normal</option>
                <option value="low">Low</option>
              </select>
            </div>

            <div>
              <label className="text-sm text-gray-400" htmlFor="riskFilter">
                Risk
              </label>
              <select
                id="riskFilter"
                value={riskFilter}
                onChange={(e) => setRiskFilter(e.target.value as RiskFilter)}
                className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-white/20"
              >
                <option value="any">Any</option>
                <option value="lower">Lower</option>
                <option value="normal">Normal</option>
                <option value="higher">Higher</option>
              </select>
            </div>
          </div>

          <div className="mt-3 text-xs text-gray-500">
            These signals are relative (quartiles) across all subnets on the page.
          </div>
        </div>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredAndSorted.map((s) => {
          const sig = signals.get(s.netuid);

          const momentumChip =
            sig?.momentum === "bullish" ? (
              <Chip
                label="Momentum: Bullish"
                tone="good"
                tooltip="Sustained net inflow of TAO into this subnet (EMA TAO flow in the top quartile)."
              />
            ) : sig?.momentum === "bearish" ? (
              <Chip
                label="Momentum: Bearish"
                tone="bad"
                tooltip="Sustained net outflow of TAO from this subnet (EMA TAO flow in the bottom quartile)."
              />
            ) : (
              <Chip
                label="Momentum: Neutral"
                tone="neutral"
                tooltip="No strong sustained inflow or outflow of TAO relative to other subnets."
              />
            );

          const yieldChip =
            sig?.yield === "high" ? (
              <Chip
                label="Yield: High"
                tone="good"
                tooltip="High emission relative to TAO staked (higher potential staking return per TAO)."
              />
            ) : sig?.yield === "low" ? (
              <Chip
                label="Yield: Low"
                tone="warn"
                tooltip="Low emission relative to TAO staked (often more crowded / lower yield)."
              />
            ) : (
              <Chip
                label="Yield: Normal"
                tone="neutral"
                tooltip="Emission-to-stake ratio is near the network average."
              />
            );

          const riskChip =
            sig?.risk === "lower" ? (
              <Chip
                label="Risk: Lower"
                tone="good"
                tooltip="High staked TAO and no overheating signs. Typically more stable."
              />
            ) : sig?.risk === "higher" ? (
              <Chip
                label="Risk: Higher"
                tone="bad"
                tooltip="Low staked TAO and/or elevated moving price. More sensitive to stake/demand changes."
              />
            ) : (
              <Chip
                label="Risk: Normal"
                tone="neutral"
                tooltip="Risk profile near the network average."
              />
            );

          return (
            <div
              key={s.netuid}
              className="
                rounded-2xl
                p-4
                bg-slate-950/90
                border border-transparent
                shadow-[0_0_0_1px_rgba(255,255,255,0.05)]
                relative
                before:absolute
                before:inset-0
                before:rounded-2xl
                before:p-[1px]
                before:bg-gradient-to-br
                before:from-cyan-400/40
                before:via-violet-500/40
                before:to-emerald-400/40
                before:content-['']
                before:-z-10
                hover:shadow-[0_0_25px_-10px_rgba(168,85,247,0.6)]
                transition-shadow
                "
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold">
                    SN<span className="tabular-nums">{s.netuid}</span>
                    {s.name ? (
                      <span className="text-gray-400 font-normal"> ({s.name})</span>
                    ) : null}
                  </div>

                  {showSignals && sig ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {momentumChip}
                      {yieldChip}
                      {riskChip}
                    </div>
                  ) : null}
                </div>

                <div className="text-xs text-gray-400">
                  EMA <Arrow dir={s.subnetEmaTaoFlowDir} />
                </div>
              </div>

              <div className="mt-4 space-y-2">
                <Stat label="Subnet emission" value={`${formatCompact(s.emission)} TAO`} />
                <Stat label="Emission share" value={formatPct(s.emissionPct)} />
                <Stat label="Subnet TAO" value={`${formatCompact(s.subnetTAO)} TAO`} />
                <Stat
                  label="TAO flow"
                  value={`${formatCompact(s.subnetTaoFlow)} TAO`}
                  right={<Arrow dir={s.subnetTaoFlowDir} />}
                />
                <Stat
                  label="EMA TAO flow"
                  value={`${formatCompact(s.subnetEmaTaoFlow)} TAO`}
                  right={<Arrow dir={s.subnetEmaTaoFlowDir} />}
                />
                <Stat label="Moving price" value={formatInt(s.subnetMovingPrice)} />
              </div>

              <div className="mt-4 flex gap-2">
                <a
                  href={`/subnets/${s.netuid}`}
                  className="flex-1 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 px-3 py-2 text-center text-sm"
                >
                  Details
                </a>
                <a
                  href={`/api/subnets`}
                  className="rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 px-3 py-2 text-sm"
                >
                  JSON
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
