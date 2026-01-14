CREATE TYPE "public"."position_type" AS ENUM('root', 'subnet');--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"address" text NOT NULL,
	"tao_usd" numeric(18, 8) NOT NULL,
	"pricing_source" text NOT NULL,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"position_type" "position_type" NOT NULL,
	"netuid" integer NOT NULL,
	"hotkey" text,
	"alpha_balance" numeric(36, 18),
	"value_tao" numeric(36, 18) NOT NULL,
	"value_usd" numeric(36, 18) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "position_snapshots" ADD CONSTRAINT "position_snapshots_snapshot_id_portfolio_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."portfolio_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portfolio_snapshots_address_captured_at_idx" ON "portfolio_snapshots" USING btree ("address","captured_at");--> statement-breakpoint
CREATE INDEX "position_snapshots_snapshot_id_idx" ON "position_snapshots" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "position_snapshots_type_netuid_idx" ON "position_snapshots" USING btree ("position_type","netuid");--> statement-breakpoint
CREATE UNIQUE INDEX "position_snapshots_snapshot_type_netuid_hotkey_uniq" ON "position_snapshots" USING btree ("snapshot_id","position_type","netuid","hotkey");