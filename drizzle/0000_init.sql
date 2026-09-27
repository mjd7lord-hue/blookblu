CREATE TYPE "public"."ad_status" AS ENUM('active', 'paused', 'closed', 'removed');--> statement-breakpoint
CREATE TYPE "public"."ad_type" AS ENUM('work', 'job', 'consult');--> statement-breakpoint
CREATE TYPE "public"."guarantee_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('none', 'pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'reviewing', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."response_status" AS ENUM('pending', 'accepted', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('worker', 'specialist', 'engineer', 'contractor', 'company', 'general');--> statement-breakpoint
CREATE TYPE "public"."saved_kind" AS ENUM('ad', 'profile');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."work_range" AS ENUM('city', 'km50', 'province', 'country');--> statement-breakpoint
CREATE TABLE "ad_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"message" text NOT NULL,
	"offer" varchar(120),
	"status" "response_status" DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"type" "ad_type" NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" text,
	"province" varchar(60) NOT NULL,
	"city" varchar(60) NOT NULL,
	"wage_type" varchar(30),
	"wage_amount" bigint,
	"start_when" varchar(40),
	"range" "work_range" DEFAULT 'city' NOT NULL,
	"audience" "role"[] NOT NULL,
	"need_count" smallint,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "ad_status" DEFAULT 'active' NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"responses_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"blocker_user_id" uuid NOT NULL,
	"blocked_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_user_id_blocked_user_id_pk" PRIMARY KEY("blocker_user_id","blocked_user_id")
);
--> statement-breakpoint
CREATE TABLE "guarantees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"guarantor_user_id" uuid,
	"guarantor_phone" varchar(11) NOT NULL,
	"guarantor_name" varchar(120) NOT NULL,
	"relation" varchar(120) NOT NULL,
	"status" "guarantee_status" DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(30) NOT NULL,
	"title" varchar(160) NOT NULL,
	"body" text,
	"link" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" varchar(11) NOT NULL,
	"code_hash" text NOT NULL,
	"purpose" varchar(20) DEFAULT 'login' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"title" varchar(80) NOT NULL,
	"experience" varchar(40),
	"rate_type" varchar(30),
	"rate_amount" bigint,
	"sort" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"code" varchar(10) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"title" varchar(160),
	"bio" text,
	"province" varchar(60) NOT NULL,
	"city" varchar(60) NOT NULL,
	"work_range" "work_range" DEFAULT 'city' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"show_phone" boolean DEFAULT false NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"week" jsonb DEFAULT '["o","o","o","o","o","o","o"]'::jsonb NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"rating_avg" real DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"done_count" integer DEFAULT 0 NOT NULL,
	"referred_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" varchar(255),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"target_profile_id" uuid,
	"target_ad_id" uuid,
	"reason" varchar(60) NOT NULL,
	"details" text,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"response_id" uuid NOT NULL,
	"from_profile_id" uuid NOT NULL,
	"to_profile_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_items" (
	"user_id" uuid NOT NULL,
	"kind" "saved_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_items_user_id_kind_target_id_pk" PRIMARY KEY("user_id","kind","target_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" varchar(11) NOT NULL,
	"first_name" varchar(60),
	"last_name" varchar(60),
	"active_role" "role",
	"kyc_status" "kyc_status" DEFAULT 'none' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "ad_responses" ADD CONSTRAINT "ad_responses_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_responses" ADD CONSTRAINT "ad_responses_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_user_id_users_id_fk" FOREIGN KEY ("blocker_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_user_id_users_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantees" ADD CONSTRAINT "guarantees_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantees" ADD CONSTRAINT "guarantees_guarantor_user_id_users_id_fk" FOREIGN KEY ("guarantor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_skills" ADD CONSTRAINT "profile_skills_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_profile_id_profiles_id_fk" FOREIGN KEY ("target_profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_ad_id_ads_id_fk" FOREIGN KEY ("target_ad_id") REFERENCES "public"."ads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_response_id_ad_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."ad_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_from_profile_id_profiles_id_fk" FOREIGN KEY ("from_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_to_profile_id_profiles_id_fk" FOREIGN KEY ("to_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_items" ADD CONSTRAINT "saved_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "responses_ad_profile_uq" ON "ad_responses" USING btree ("ad_id","profile_id");--> statement-breakpoint
CREATE INDEX "responses_profile_idx" ON "ad_responses" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "ads_type_status_idx" ON "ads" USING btree ("type","status","created_at");--> statement-breakpoint
CREATE INDEX "ads_profile_idx" ON "ads" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "ads_place_idx" ON "ads" USING btree ("province","city");--> statement-breakpoint
CREATE UNIQUE INDEX "guarantees_profile_phone_uq" ON "guarantees" USING btree ("profile_id","guarantor_phone");--> statement-breakpoint
CREATE INDEX "guarantees_guarantor_idx" ON "guarantees" USING btree ("guarantor_user_id","status");--> statement-breakpoint
CREATE INDEX "notif_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "otp_phone_created_idx" ON "otp_codes" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "skills_profile_idx" ON "profile_skills" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_user_role_uq" ON "profiles" USING btree ("user_id","role");--> statement-breakpoint
CREATE INDEX "profiles_role_idx" ON "profiles" USING btree ("role");--> statement-breakpoint
CREATE INDEX "profiles_place_idx" ON "profiles" USING btree ("province","city");--> statement-breakpoint
CREATE INDEX "refresh_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_response_from_uq" ON "reviews" USING btree ("response_id","from_profile_id");--> statement-breakpoint
CREATE INDEX "reviews_to_idx" ON "reviews" USING btree ("to_profile_id","created_at");