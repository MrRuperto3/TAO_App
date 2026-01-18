CREATE TABLE "subnet_metric_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" text NOT NULL,
	"netuid" integer NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"flow_24h" numeric(36, 18),
	"emission_pct" numeric(36, 18),
	"price" numeric(36, 18),
	"liquidity" numeric(36, 18),
	"tao_volume_24h" numeric(36, 18),
	"price_change_1d" numeric(36, 18),
	"price_change_1w" numeric(36, 18),
	"price_change_1m" numeric(36, 18)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "subnet_metric_snapshots_day_netuid_uniq" ON "subnet_metric_snapshots" USING btree ("day","netuid");--> statement-breakpoint
CREATE INDEX "subnet_metric_snapshots_day_idx" ON "subnet_metric_snapshots" USING btree ("day");--> statement-breakpoint
CREATE INDEX "subnet_metric_snapshots_netuid_idx" ON "subnet_metric_snapshots" USING btree ("netuid");--> statement-breakpoint
CREATE INDEX "subnet_metric_snapshots_day_netuid_idx" ON "subnet_metric_snapshots" USING btree ("day","netuid");