CREATE TABLE "analytics_events" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "analytics_events_name_created_idx" ON "analytics_events" USING btree ("name","created_at");
