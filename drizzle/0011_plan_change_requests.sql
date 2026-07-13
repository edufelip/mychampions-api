CREATE TABLE "plan_change_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"plan_type" text NOT NULL,
	"student_auth_uid" text NOT NULL,
	"request_text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "plan_change_requests_student_created_idx" ON "plan_change_requests" USING btree ("student_auth_uid","created_at");--> statement-breakpoint
CREATE INDEX "plan_change_requests_plan_idx" ON "plan_change_requests" USING btree ("plan_type","plan_id");
