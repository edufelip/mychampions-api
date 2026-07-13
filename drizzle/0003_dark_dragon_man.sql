CREATE TABLE "invite_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"professional_auth_uid" text NOT NULL,
	"specialty" text NOT NULL,
	"code_value" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invite_codes_code_value_idx" ON "invite_codes" USING btree ("code_value");