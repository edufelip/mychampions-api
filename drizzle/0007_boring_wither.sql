CREATE TABLE "professional_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"specialty_id" text NOT NULL,
	"professional_auth_uid" text NOT NULL,
	"specialty" text NOT NULL,
	"credential_type" text NOT NULL,
	"registry_id" text NOT NULL,
	"authority" text NOT NULL,
	"country" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "professional_specialties" (
	"id" text PRIMARY KEY NOT NULL,
	"professional_auth_uid" text NOT NULL,
	"specialty" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "professional_specialties_owner_specialty_idx" ON "professional_specialties" USING btree ("professional_auth_uid","specialty");