CREATE TYPE "public"."urgent_offer_status" AS ENUM('sent', 'accepted', 'declined', 'missed');--> statement-breakpoint
CREATE TYPE "public"."urgent_status" AS ENUM('open', 'filled', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "urgent_offers" (
	"request_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"ad_id" uuid,
	"status" "urgent_offer_status" DEFAULT 'sent' NOT NULL,
	"project_id" uuid,
	"conversation_id" uuid,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "urgent_offers_request_id_profile_id_pk" PRIMARY KEY("request_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "urgent_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_profile_id" uuid NOT NULL,
	"title" varchar(120) NOT NULL,
	"skill" varchar(60),
	"roles" "role"[] NOT NULL,
	"need_count" smallint DEFAULT 1 NOT NULL,
	"province" varchar(60) NOT NULL,
	"city" varchar(60) NOT NULL,
	"start_when" varchar(60) NOT NULL,
	"daily_wage" bigint NOT NULL,
	"days" smallint DEFAULT 1 NOT NULL,
	"note" text,
	"status" "urgent_status" DEFAULT 'open' NOT NULL,
	"sent_count" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "urgent_offers" ADD CONSTRAINT "urgent_offers_request_id_urgent_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."urgent_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "urgent_offers" ADD CONSTRAINT "urgent_offers_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "urgent_offers" ADD CONSTRAINT "urgent_offers_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "urgent_offers" ADD CONSTRAINT "urgent_offers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "urgent_offers" ADD CONSTRAINT "urgent_offers_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "urgent_requests" ADD CONSTRAINT "urgent_requests_client_profile_id_profiles_id_fk" FOREIGN KEY ("client_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "urgent_offers_profile_idx" ON "urgent_offers" USING btree ("profile_id","status");--> statement-breakpoint
CREATE INDEX "urgent_client_idx" ON "urgent_requests" USING btree ("client_profile_id","status");