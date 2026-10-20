CREATE TYPE "public"."strike_kind" AS ENUM('no_show', 'cancel', 'breach');--> statement-breakpoint
CREATE TYPE "public"."strike_status" AS ENUM('pending', 'disputed', 'confirmed', 'dismissed');--> statement-breakpoint
CREATE TABLE "strikes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"by_profile_id" uuid,
	"project_id" uuid,
	"kind" "strike_kind" NOT NULL,
	"status" "strike_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"reply" text,
	"respond_by" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "trust_adj" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "restricted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "cancel_req_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "cancel_req_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "cancel_req_reason" text;--> statement-breakpoint
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_by_profile_id_profiles_id_fk" FOREIGN KEY ("by_profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strikes_profile_idx" ON "strikes" USING btree ("profile_id","status");--> statement-breakpoint
CREATE INDEX "strikes_project_idx" ON "strikes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "strikes_status_idx" ON "strikes" USING btree ("status");