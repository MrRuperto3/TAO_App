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
    snapshotIdIdx: index("position_snapshots_snapshot_id_idx").on(
      t.snapshotId
    ),

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
