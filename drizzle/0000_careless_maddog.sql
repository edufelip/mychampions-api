CREATE TABLE "user_profiles" (
	"auth_uid" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"email_normalized" text NOT NULL,
	"locked_role" text,
	"accepted_terms_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
