CREATE TABLE "cron_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"message" text,
	"duration_ms" integer,
	"snapshots_inserted" integer,
	"positions_inserted" integer
);
--> statement-breakpoint
CREATE INDEX "cron_runs_job_ran_at_idx" ON "cron_runs" USING btree ("job","ran_at");