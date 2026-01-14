DROP INDEX "portfolio_snapshots_address_captured_at_idx";--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ALTER COLUMN "tao_usd" SET DATA TYPE numeric(30, 18);--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ALTER COLUMN "tao_usd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD COLUMN "total_value_tao" numeric(30, 18);--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD COLUMN "total_value_usd" numeric(30, 18);--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" DROP COLUMN "pricing_source";--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" DROP COLUMN "raw";