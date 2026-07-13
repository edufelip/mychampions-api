CREATE TABLE "support_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_uid" text NOT NULL,
	"user_email" text NOT NULL,
	"user_name" text NOT NULL,
	"user_role" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"app_version" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
