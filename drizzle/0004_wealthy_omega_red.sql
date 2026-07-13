CREATE TABLE "workout_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_auth_uid" text NOT NULL,
	"session_id" text NOT NULL,
	"session_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workout_logs_owner_created_at_idx" ON "workout_logs" USING btree ("owner_auth_uid","created_at");