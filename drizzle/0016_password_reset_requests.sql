CREATE TABLE "password_reset_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"email_normalized" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "password_reset_requests_email_requested_idx" ON "password_reset_requests" USING btree ("email_normalized","requested_at");
