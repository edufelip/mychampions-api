CREATE TABLE "nutrition_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"student_auth_uid" text NOT NULL,
	"owner_professional_uid" text,
	"source_kind" text NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"hydration_goal_ml" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "nutrition_plans_student_updated_idx" ON "nutrition_plans" USING btree ("student_auth_uid","updated_at");--> statement-breakpoint
CREATE INDEX "nutrition_plans_owner_idx" ON "nutrition_plans" USING btree ("owner_professional_uid");