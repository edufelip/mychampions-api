CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"canceled_reason" text,
	"specialty" text NOT NULL,
	"professional_auth_uid" text NOT NULL,
	"student_auth_uid" text NOT NULL,
	"source_invite_code_id" text,
	"source_invite_code_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
