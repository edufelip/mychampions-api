ALTER TABLE "subscription_entitlement_snapshots" ADD COLUMN "professional_entitlement_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription_entitlement_snapshots" ADD COLUMN "professional_entitlement_renewal_risk" boolean DEFAULT false NOT NULL;
