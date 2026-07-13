CREATE TABLE "meal_share_links" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_auth_uid" text NOT NULL,
	"meal_id" text NOT NULL,
	"snapshot_name" text NOT NULL,
	"snapshot_total_grams" numeric NOT NULL,
	"snapshot_calories" numeric NOT NULL,
	"snapshot_carbs" numeric NOT NULL,
	"snapshot_proteins" numeric NOT NULL,
	"snapshot_fats" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "meal_share_links_owner_meal_idx" ON "meal_share_links" USING btree ("owner_auth_uid","meal_id");--> statement-breakpoint
CREATE INDEX "meal_share_links_meal_idx" ON "meal_share_links" USING btree ("meal_id");