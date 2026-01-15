export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <main className="min-h-screen">
      <div className="p-4 sm:p-6">
        <div className="mx-auto max-w-5xl">
          {/* Header */}
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-3">
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                  TAO Dashboard
                </h1>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-300">
                  Read-only
                </span>
              </div>

              <p className="mt-2 text-sm text-gray-400">
                Portfolio + subnet analytics for Bittensor (TAO). No wallet
                connections. Server-fetched data.
              </p>
            </div>

            <a
              href="https://taostats.io"
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-200 hover:bg-white/10 hover:text-white transition"
            >
              Taostats
            </a>
          </div>

          {/* Primary navigation */}
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <a
              href="/portfolio"
              className="group rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.03)] transition hover:bg-white/10"
            >
              <div className="flex items-center justify-between">
                <div className="text-lg font-semibold text-gray-100">
                  Portfolio
                </div>
                <span className="text-gray-400 group-hover:text-gray-200 transition">
                  →
                </span>
              </div>
              <p className="mt-2 text-sm text-gray-400">
                View TAO balances, root stake, subnet (alpha) positions, and
                realized APY as snapshots accumulate.
              </p>
              <div className="mt-3 text-xs text-gray-500">
                Root is handled separately (netuid 0).
              </div>
            </a>

            <a
              href="/subnets"
              className="group rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.03)] transition hover:bg-white/10"
            >
              <div className="flex items-center justify-between">
                <div className="text-lg font-semibold text-gray-100">
                  Subnets
                </div>
                <span className="text-gray-400 group-hover:text-gray-200 transition">
                  →
                </span>
              </div>
              <p className="mt-2 text-sm text-gray-400">
                Explore subnet emissions, TAO flows, moving prices, and filters
                to find high-signal opportunities.
              </p>
              <div className="mt-3 text-xs text-gray-500">
                Includes bullish/bearish flow indicators.
              </div>
            </a>
          </div>

          {/* Coming soon */}
          <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
            <div className="text-sm font-semibold text-gray-100">
              Coming soon
            </div>
            <ul className="mt-3 space-y-2 text-sm text-gray-400">
              <li>• TAO/USD price chart (time-series)</li>
              <li>• Bittensor (TAO) news feed</li>
              <li>• Network stats (circulating supply, total staked, etc.)</li>
              <li>• Portfolio performance charts (TAO & USD)</li>
              <li>• Flow-aware realized APY (stake adds/removals adjustments)</li>
            </ul>
            <div className="mt-3 text-xs text-gray-500">
              These will be server-fetched and remain hydration-safe.
            </div>
          </div>

          {/* Footer */}
          <div className="mt-10 text-xs text-gray-500">
            Tip: Deploying to Vercel enables scheduled snapshots so realized APY
            and history charts become meaningful over time.
          </div>
        </div>
      </div>
    </main>
  );
}
