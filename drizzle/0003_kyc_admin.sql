CREATE TYPE "public"."kyc_id_type" AS ENUM('national', 'foreign');--> statement-breakpoint
ALTER TYPE "public"."file_purpose" ADD VALUE 'kyc';--> statement-breakpoint
CREATE TABLE "admin_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid,
	"action" varchar(40) NOT NULL,
	"target_type" varchar(20) NOT NULL,
	"target_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyc_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"first_name" varchar(60) NOT NULL,
	"last_name" varchar(60) NOT NULL,
	"id_type" "kyc_id_type" DEFAULT 'national' NOT NULL,
	"id_number" varchar(30),
	"card_file_id" uuid,
	"selfie_file_id" uuid,
	"status" "document_status" DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "admin_note" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "handled_by" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "handled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_card_file_id_files_id_fk" FOREIGN KEY ("card_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_selfie_file_id_files_id_fk" FOREIGN KEY ("selfie_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_actions_created_idx" ON "admin_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_actions_target_idx" ON "admin_actions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "kyc_user_idx" ON "kyc_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "kyc_status_idx" ON "kyc_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "kyc_id_number_idx" ON "kyc_requests" USING btree ("id_number");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;