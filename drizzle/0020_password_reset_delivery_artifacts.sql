CREATE TABLE "password_reset_delivery_artifacts" (
	"request_id" text PRIMARY KEY NOT NULL,
	"email_normalized" text NOT NULL,
	"channel" text NOT NULL,
	"reset_token" text NOT NULL,
	"reset_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_delivery_artifacts_request_id_password_reset_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."password_reset_requests"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "password_reset_delivery_email_created_idx" ON "password_reset_delivery_artifacts" USING btree ("email_normalized","created_at");
--> statement-breakpoint
CREATE INDEX "password_reset_delivery_expires_idx" ON "password_reset_delivery_artifacts" USING btree ("expires_at");
