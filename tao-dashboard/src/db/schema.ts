import {
  pgTable,
  uuid,
  timestamp,
  text,
  numeric,
  integer,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";

// Explicit enum to keep Root vs Subnet unambiguous
export const positionTypeEnum = pgEnum("position_type", ["root", "subnet"]);

export const portfolioSnapshots = pgTable("portfolio_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),

  address: text("address").notNull(),

  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),

  taoUsd: numeric("tao_usd", { precision: 30, scale: 18 }),

  totalValueTao: numeric("total_value_tao", { precision: 30, scale: 18 }),

  totalValueUsd: numeric("total_value_usd", { precision: 30, scale: 18 }),
});

export const positionSnapshots = pgTable(
  "position_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => portfolioSnapshots.id, { onDelete: "cascade" }),

    positionType: positionTypeEnum("position_type").notNull(),

    // netuid: 0 for root, subnet netuid otherwise
    netuid: integer("netuid").notNull(),

    // hotkey applies to subnets; null for root
    hotkey: text("hotkey"),

    // subnet only
    alphaBalance: numeric("alpha_balance", { precision: 36, scale: 18 }),

    valueTao: numeric("value_tao", { precision: 36, scale: 18 }).notNull(),
    valueUsd: numeric("value_usd", { precision: 36, scale: 18 }).notNull(),
  },
  (t) => ({
    snapshotIdIdx: index("position_snapshots_snapshot_id_idx").on(t.snapshotId),

    typeNetuidIdx: index("position_snapshots_type_netuid_idx").on(
      t.positionType,
      t.netuid
    ),

    snapshotUniq: uniqueIndex(
      "position_snapshots_snapshot_type_netuid_hotkey_uniq"
    ).on(t.snapshotId, t.positionType, t.netuid, t.hotkey),
  })
);

export const cronRuns = pgTable(
  "cron_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // which cron (so you can add more later)
    job: text("job").notNull(), // e.g. "snapshot"

    ranAt: timestamp("ran_at", { withTimezone: true }).notNull(),

    ok: boolean("ok").notNull(),

    message: text("message"), // error or summary

    durationMs: integer("duration_ms"),

    // how many snapshots/positions were written (best-effort)
    snapshotsInserted: integer("snapshots_inserted"),
    positionsInserted: integer("positions_inserted"),
  },
  (t) => ({
    jobRanAtIdx: index("cron_runs_job_ran_at_idx").on(t.job, t.ranAt),
  })
);

/**
 * Daily subnet-level metrics used for signals/notifications.
 * One row per (UTC day, netuid).
 *
 * day: UTC day key in YYYY-MM-DD form (matches your existing UTC-day idempotency).
 * capturedAt: when the metrics were fetched (timestamptz).
 */
export const subnetMetricSnapshots = pgTable(
  "subnet_metric_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // UTC day key, e.g. "2026-01-17"
    day: text("day").notNull(),

    // subnet id
    netuid: integer("netuid").notNull(),

    // when we captured the metric snapshot (timestamptz)
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),

    // TAO Flow (24H): net staking flow into/out of subnet pool
    flow24h: numeric("flow_24h", { precision: 36, scale: 18 }),

    // Emission share percentage for the subnet (store as percent, e.g. 1.23 for 1.23%)
    emissionPct: numeric("emission_pct", { precision: 36, scale: 18 }),

    // Pool / market stats
    price: numeric("price", { precision: 36, scale: 18 }),
    liquidity: numeric("liquidity", { precision: 36, scale: 18 }),
    taoVolume24h: numeric("tao_volume_24h", { precision: 36, scale: 18 }),

    // Price change windows as percent (e.g. -12.34 for -12.34%)
    priceChange1d: numeric("price_change_1d", { precision: 36, scale: 18 }),
    priceChange1w: numeric("price_change_1w", { precision: 36, scale: 18 }),
    priceChange1m: numeric("price_change_1m", { precision: 36, scale: 18 }),

    // optional: stash raw payloads for debugging / provenance (keep nullable)
    // raw: jsonb("raw"),
  },
  (t) => ({
    dayNetuidUniq: uniqueIndex("subnet_metric_snapshots_day_netuid_uniq").on(
      t.day,
      t.netuid
    ),

    dayIdx: index("subnet_metric_snapshots_day_idx").on(t.day),
    netuidIdx: index("subnet_metric_snapshots_netuid_idx").on(t.netuid),
    dayNetuidIdx: index("subnet_metric_snapshots_day_netuid_idx").on(
      t.day,
      t.netuid
    ),
  })
);
