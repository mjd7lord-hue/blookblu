CREATE TYPE "public"."contract_status" AS ENUM('draft', 'signing', 'active', 'void');--> statement-breakpoint
CREATE TYPE "public"."party_side" AS ENUM('client', 'provider');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('recorded', 'confirmed', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."statement_status" AS ENUM('draft', 'sent', 'approved', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."file_purpose" ADD VALUE 'project';--> statement-breakpoint
CREATE TABLE "contract_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"version" smallint NOT NULL,
	"side" "party_side" NOT NULL,
	"profile_id" uuid,
	"user_id" uuid,
	"phone" varchar(11) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(255),
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"number" varchar(30) NOT NULL,
	"version" smallint DEFAULT 1 NOT NULL,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"terms" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "daily_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"author_profile_id" uuid NOT NULL,
	"report_date" date NOT NULL,
	"weather" varchar(30),
	"crew" smallint DEFAULT 0 NOT NULL,
	"done" text NOT NULL,
	"issues" text,
	"photo_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_by_profile_id" uuid,
	"amount" bigint NOT NULL,
	"label" varchar(40) NOT NULL,
	"milestone_index" smallint,
	"statement_id" uuid,
	"paid_on" date NOT NULL,
	"note" text,
	"status" "payment_status" DEFAULT 'recorded' NOT NULL,
	"dispute_reason" text,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" smallint NOT NULL,
	"status" "statement_status" DEFAULT 'draft' NOT NULL,
	"items" jsonb NOT NULL,
	"retention_pct" real DEFAULT 0 NOT NULL,
	"insurance_pct" real DEFAULT 0 NOT NULL,
	"totals" jsonb NOT NULL,
	"note" text,
	"reject_reason" text,
	"created_by_profile_id" uuid,
	"sent_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "contract_signatures" ADD CONSTRAINT "contract_signatures_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signatures" ADD CONSTRAINT "contract_signatures_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signatures" ADD CONSTRAINT "contract_signatures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_author_profile_id_profiles_id_fk" FOREIGN KEY ("author_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_payments" ADD CONSTRAINT "project_payments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_payments" ADD CONSTRAINT "project_payments_recorded_by_profile_id_profiles_id_fk" FOREIGN KEY ("recorded_by_profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_payments" ADD CONSTRAINT "project_payments_statement_id_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."statements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_created_by_profile_id_profiles_id_fk" FOREIGN KEY ("created_by_profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_sig_uq" ON "contract_signatures" USING btree ("contract_id","version","side");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_project_author_date_uq" ON "daily_reports" USING btree ("project_id","author_profile_id","report_date");--> statement-breakpoint
CREATE INDEX "daily_project_idx" ON "daily_reports" USING btree ("project_id","report_date");--> statement-breakpoint
CREATE INDEX "payments_project_idx" ON "project_payments" USING btree ("project_id","paid_on");--> statement-breakpoint
CREATE UNIQUE INDEX "statements_project_number_uq" ON "statements" USING btree ("project_id","number");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_project_idx" ON "files" USING btree ("project_id");