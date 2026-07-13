CREATE TABLE "auth_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "auth_uid" text NOT NULL,
  "refresh_token_digest" text NOT NULL,
  "auth_provider_id" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "replaced_by_session_id" text
);
--> statement-breakpoint
CREATE INDEX "auth_sessions_auth_uid_idx" ON "auth_sessions" USING btree ("auth_uid");
--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" USING btree ("expires_at");
