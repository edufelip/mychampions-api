CREATE TABLE "local_email_auth_credentials" (
	"auth_uid" text PRIMARY KEY NOT NULL,
	"email_normalized" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "local_email_auth_credentials_email_idx" ON "local_email_auth_credentials" USING btree ("email_normalized");
