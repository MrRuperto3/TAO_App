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
} from "drizzle-orm/pg-core";

// Explicit enum to keep Root vs Subnet unambiguous
export const positionTypeEnum = pgEnum("position_type", ["root", "subnet"]);

export const portfolioSnapshots = pgTable(
  "portfolio_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),

    address: text("address").notNull(),

    taoUsd: numeric("tao_usd", { precision: 18, scale: 8 }).notNull(),
    pricingSource: text("pricing_source").notNull(),

    // Store raw portfolio payload for debugging/backfills
    raw: jsonb("raw").notNull(),
  },
  (t) => ({
    addressCapturedAtIdx: index(
      "portfolio_snapshots_address_captured_at_idx"
    ).on(t.address, t.capturedAt),
  })
);

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
