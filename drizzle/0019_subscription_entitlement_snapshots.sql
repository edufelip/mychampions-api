CREATE TABLE "subscription_entitlement_snapshots" (
	"auth_uid" text PRIMARY KEY NOT NULL,
	"professional_entitlement_status" text NOT NULL,
	"ai_entitlement_status" text NOT NULL,
	"active_student_count" integer,
	"source" text DEFAULT 'revenuecat' NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "subscription_entitlement_snapshots_observed_idx" ON "subscription_entitlement_snapshots" USING btree ("observed_at");
