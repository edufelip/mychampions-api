ALTER TABLE "password_reset_requests" ADD COLUMN "token_digest" text DEFAULT 'legacy-local-reset-token-digest' NOT NULL;
--> statement-breakpoint
ALTER TABLE "password_reset_requests" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '30 minutes' NOT NULL;
--> statement-breakpoint
ALTER TABLE "password_reset_requests" ALTER COLUMN "token_digest" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "password_reset_requests" ALTER COLUMN "expires_at" DROP DEFAULT;
--> statement-breakpoint
CREATE INDEX "password_reset_requests_expires_idx" ON "password_reset_requests" USING btree ("expires_at");
