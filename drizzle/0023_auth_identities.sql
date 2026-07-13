CREATE TABLE "auth_identities" (
  "provider" text NOT NULL,
  "provider_subject" text NOT NULL,
  "auth_uid" text NOT NULL,
  "email_normalized" text NOT NULL,
  "display_name" text NOT NULL,
  "email_verified" boolean NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_identities_provider_subject_pk" PRIMARY KEY("provider", "provider_subject")
);
--> statement-breakpoint
CREATE INDEX "auth_identities_auth_uid_idx" ON "auth_identities" USING btree ("auth_uid");
