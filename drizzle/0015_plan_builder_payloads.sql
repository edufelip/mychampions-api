ALTER TABLE "nutrition_plans" ADD COLUMN "meals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "training_plans" ADD COLUMN "sessions" jsonb DEFAULT '[]'::jsonb NOT NULL;
