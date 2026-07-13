ALTER TABLE "nutrition_plans" ADD COLUMN "is_draft" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "nutrition_plans" ADD COLUMN "name" text;
--> statement-breakpoint
ALTER TABLE "nutrition_plans" ADD COLUMN "calories_target" integer;
--> statement-breakpoint
ALTER TABLE "nutrition_plans" ADD COLUMN "carbs_target" integer;
--> statement-breakpoint
ALTER TABLE "nutrition_plans" ADD COLUMN "proteins_target" integer;
--> statement-breakpoint
ALTER TABLE "nutrition_plans" ADD COLUMN "fats_target" integer;
--> statement-breakpoint
CREATE TABLE "training_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"student_auth_uid" text NOT NULL,
	"owner_professional_uid" text,
	"source_kind" text NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "training_plans_student_updated_idx" ON "training_plans" USING btree ("student_auth_uid","updated_at");
--> statement-breakpoint
CREATE INDEX "training_plans_owner_idx" ON "training_plans" USING btree ("owner_professional_uid");
