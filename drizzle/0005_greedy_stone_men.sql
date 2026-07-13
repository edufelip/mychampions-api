CREATE TABLE "water_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_auth_uid" text NOT NULL,
	"date_key" text NOT NULL,
	"total_ml" integer NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "water_logs_owner_date_key_idx" ON "water_logs" USING btree ("owner_auth_uid","date_key");