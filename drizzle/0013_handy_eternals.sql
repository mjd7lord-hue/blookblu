CREATE TYPE "public"."role_request_mode" AS ENUM('add', 'switch');--> statement-breakpoint
CREATE TYPE "public"."role_request_status" AS ENUM('pending', 'approved', 'rejected', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "role_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_role" "role",
	"to_role" "role" NOT NULL,
	"mode" "role_request_mode" DEFAULT 'switch' NOT NULL,
	"note" text,
	"status" "role_request_status" DEFAULT 'pending' NOT NULL,
	"admin_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_unlock" "role";--> statement-breakpoint
ALTER TABLE "role_requests" ADD CONSTRAINT "role_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_requests" ADD CONSTRAINT "role_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_requests_user_idx" ON "role_requests" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "role_requests_status_idx" ON "role_requests" USING btree ("status");