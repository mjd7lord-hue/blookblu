CREATE TYPE "public"."gateway_payment_status" AS ENUM('pending', 'paid', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "gateway_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" varchar(20) NOT NULL,
	"target_id" uuid NOT NULL,
	"plan" varchar(20),
	"amount" bigint NOT NULL,
	"description" varchar(200) NOT NULL,
	"gateway" varchar(20) NOT NULL,
	"authority" varchar(64),
	"status" "gateway_payment_status" DEFAULT 'pending' NOT NULL,
	"ref_id" varchar(40),
	"card_pan" varchar(20),
	"fail_reason" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ads" ADD COLUMN "featured_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ads" ADD COLUMN "urgent_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ads" ADD COLUMN "bumped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_payments" ADD CONSTRAINT "gateway_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_payments_authority_uq" ON "gateway_payments" USING btree ("authority");--> statement-breakpoint
CREATE INDEX "gateway_payments_user_idx" ON "gateway_payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "gateway_payments_target_idx" ON "gateway_payments" USING btree ("purpose","target_id");