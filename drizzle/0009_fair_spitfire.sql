CREATE TABLE "custom_meals" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_auth_uid" text NOT NULL,
	"name" text NOT NULL,
	"total_grams" numeric NOT NULL,
	"calories" numeric NOT NULL,
	"carbs" numeric NOT NULL,
	"proteins" numeric NOT NULL,
	"fats" numeric NOT NULL,
	"ingredient_cost" numeric,
	"image_url" text,
	"imported_from_share_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "custom_meals_owner_updated_idx" ON "custom_meals" USING btree ("owner_auth_uid","updated_at");--> statement-breakpoint
CREATE INDEX "custom_meals_imported_share_token_idx" ON "custom_meals" USING btree ("imported_from_share_token");