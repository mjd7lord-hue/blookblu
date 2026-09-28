CREATE TYPE "public"."arb_case_status" AS ENUM('awaiting_payment', 'matching', 'offered', 'assigned', 'reported', 'appealed', 'final', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."arb_payment_status" AS ENUM('unpaid', 'paid', 'released', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."arbiter_range" AS ENUM('city', 'province', 'neighbors');--> statement-breakpoint
CREATE TYPE "public"."arbiter_status" AS ENUM('pending', 'approved', 'rejected', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'arbitration', 'settled', 'decided', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."file_purpose" ADD VALUE 'arbitration';--> statement-breakpoint
CREATE TABLE "arbiter_ratings" (
	"case_id" uuid NOT NULL,
	"from_profile_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"impartial" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arbiter_ratings_case_id_from_profile_id_pk" PRIMARY KEY("case_id","from_profile_id")
);
--> statement-breakpoint
CREATE TABLE "arbiters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"fields" text[] NOT NULL,
	"range" "arbiter_range" DEFAULT 'province' NOT NULL,
	"doc_file_id" uuid,
	"pledged_at" timestamp with time zone NOT NULL,
	"status" "arbiter_status" DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rating_avg" real DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"impartial_no" integer DEFAULT 0 NOT NULL,
	"cases_done" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arbiters_profile_id_unique" UNIQUE("profile_id")
);
--> statement-breakpoint
CREATE TABLE "arbitration_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"round" smallint DEFAULT 1 NOT NULL,
	"payer_profile_id" uuid,
	"field" varchar(10) NOT NULL,
	"amount_million" integer NOT NULL,
	"multi" boolean DEFAULT false NOT NULL,
	"fee" bigint NOT NULL,
	"travel" bigint DEFAULT 0 NOT NULL,
	"travel_kind" varchar(8) DEFAULT 'city' NOT NULL,
	"commission_pct" smallint NOT NULL,
	"commission" bigint NOT NULL,
	"arbiter_share" bigint NOT NULL,
	"total" bigint NOT NULL,
	"status" "arb_case_status" DEFAULT 'awaiting_payment' NOT NULL,
	"payment_status" "arb_payment_status" DEFAULT 'unpaid' NOT NULL,
	"payment_ref" varchar(80),
	"paid_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"refund_reason" text,
	"arbiter_id" uuid,
	"skip_arbiter_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"party_rejects" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"offered_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"visit_text" varchar(80),
	"report" jsonb,
	"photo_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"reported_at" timestamp with time zone,
	"appeal_until" timestamp with time zone,
	"appeal_reason" text,
	"party_accepts" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"fee_return_due" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"opened_by_profile_id" uuid NOT NULL,
	"against_profile_id" uuid NOT NULL,
	"reason" varchar(40) NOT NULL,
	"ask" varchar(60) NOT NULL,
	"description" text NOT NULL,
	"city" varchar(60) NOT NULL,
	"province" varchar(60) NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"talk_until" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "arbiter_ratings" ADD CONSTRAINT "arbiter_ratings_case_id_arbitration_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."arbitration_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arbiter_ratings" ADD CONSTRAINT "arbiter_ratings_from_profile_id_profiles_id_fk" FOREIGN KEY ("from_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arbiters" ADD CONSTRAINT "arbiters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arbiters" ADD CONSTRAINT "arbiters_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arbiters" ADD CONSTRAINT "arbiters_doc_file_id_files_id_fk" FOREIGN KEY ("doc_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arbiters" ADD CONSTRAINT "arbiters_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arbitration_cases" ADD CONSTRAINT "arbitration_cases_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arbitration_cases" ADD CONSTRAINT "arbitration_cases_payer_profile_id_profiles_id_fk" FOREIGN KEY ("payer_profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arbitration_cases" ADD CONSTRAINT "arbitration_cases_arbiter_id_arbiters_id_fk" FOREIGN KEY ("arbiter_id") REFERENCES "public"."arbiters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_opened_by_profile_id_profiles_id_fk" FOREIGN KEY ("opened_by_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_against_profile_id_profiles_id_fk" FOREIGN KEY ("against_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "arbiters_status_idx" ON "arbiters" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "arb_case_dispute_round_uq" ON "arbitration_cases" USING btree ("dispute_id","round") WHERE status not in ('refunded', 'cancelled');--> statement-breakpoint
CREATE INDEX "arb_case_arbiter_idx" ON "arbitration_cases" USING btree ("arbiter_id","status");--> statement-breakpoint
CREATE INDEX "arb_case_status_idx" ON "arbitration_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "disputes_project_idx" ON "disputes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "disputes_status_idx" ON "disputes" USING btree ("status");