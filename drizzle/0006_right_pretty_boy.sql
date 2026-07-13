CREATE TABLE "portion_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_auth_uid" text NOT NULL,
	"meal_id" text NOT NULL,
	"consumed_grams" numeric NOT NULL,
	"snapshot_calories" numeric NOT NULL,
	"snapshot_carbs" numeric NOT NULL,
	"snapshot_proteins" numeric NOT NULL,
	"snapshot_fats" numeric NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_id" text,
	"plan_type" text,
	"source_kind" text,
	"owner_professional_uid" text,
	"connection_id" text
);
--> statement-breakpoint
CREATE INDEX "portion_logs_owner_logged_at_idx" ON "portion_logs" USING btree ("owner_auth_uid","logged_at");