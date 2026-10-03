ALTER TYPE "public"."file_purpose" ADD VALUE 'receipt';--> statement-breakpoint
ALTER TABLE "project_payments" ADD COLUMN "receipt_file_id" uuid;--> statement-breakpoint
ALTER TABLE "project_payments" ADD COLUMN "receipt_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "project_payments" ADD COLUMN "tracking_no" varchar(40);--> statement-breakpoint
ALTER TABLE "project_payments" ADD COLUMN "bank" varchar(40);--> statement-breakpoint
ALTER TABLE "project_payments" ADD COLUMN "checks" jsonb;--> statement-breakpoint
ALTER TABLE "project_payments" ADD CONSTRAINT "project_payments_receipt_file_id_files_id_fk" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tracking_uq" ON "project_payments" USING btree ("tracking_no") WHERE tracking_no is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_receipt_hash_uq" ON "project_payments" USING btree ("receipt_hash") WHERE receipt_hash is not null;