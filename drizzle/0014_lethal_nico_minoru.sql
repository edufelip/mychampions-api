CREATE TABLE "active_specialties" (
	"id" text PRIMARY KEY NOT NULL,
	"student_auth_uid" text NOT NULL,
	"professional_auth_uid" text NOT NULL,
	"specialty" text NOT NULL,
	"connection_id" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_invite_guards" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"professional_auth_uid" text NOT NULL,
	"student_auth_uid" text NOT NULL,
	"specialty" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_student_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"professional_auth_uid" text NOT NULL,
	"slot_id" text NOT NULL,
	"student_auth_uid" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_students" (
	"id" text PRIMARY KEY NOT NULL,
	"professional_auth_uid" text NOT NULL,
	"student_auth_uid" text NOT NULL,
	"slot_id" text NOT NULL,
	"nutritionist_connection_id" text,
	"fitness_coach_connection_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracking_access" (
	"id" text PRIMARY KEY NOT NULL,
	"student_auth_uid" text NOT NULL,
	"professional_auth_uid" text NOT NULL,
	"specialty" text NOT NULL,
	"connection_id" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "active_specialties_student_specialty_idx" ON "active_specialties" USING btree ("student_auth_uid","specialty");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_student_slots_professional_slot_idx" ON "pending_student_slots" USING btree ("professional_auth_uid","slot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_students_professional_student_idx" ON "pending_students" USING btree ("professional_auth_uid","student_auth_uid");