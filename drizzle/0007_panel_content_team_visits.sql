CREATE TYPE "public"."attendance_status" AS ENUM('p', 'a', 'l');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('high', 'mid', 'low');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'pending', 'closed');--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('requested', 'confirmed', 'declined', 'cancelled', 'done');--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" varchar(40) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arbiter_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arbiter_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"ref" varchar(120) NOT NULL,
	"admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"member_id" uuid NOT NULL,
	"day" date NOT NULL,
	"status" "attendance_status" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_member_id_day_pk" PRIMARY KEY("member_id","day")
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(160) NOT NULL,
	"body" text,
	"link" jsonb,
	"target" jsonb NOT NULL,
	"target_text" varchar(300) NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_stats" (
	"kind" varchar(10) NOT NULL,
	"item_id" varchar(40) NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "content_stats_kind_item_id_pk" PRIMARY KEY("kind","item_id")
);
--> statement-breakpoint
CREATE TABLE "course_progress" (
	"user_id" uuid NOT NULL,
	"course_id" varchar(40) NOT NULL,
	"done" smallint DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_progress_user_id_course_id_pk" PRIMARY KEY("user_id","course_id")
);
--> statement-breakpoint
CREATE TABLE "crew_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_profile_id" uuid NOT NULL,
	"member_profile_id" uuid,
	"name" varchar(80) NOT NULL,
	"skill" varchar(60) NOT NULL,
	"daily_wage" bigint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"no" serial NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" varchar(160),
	"category" varchar(40) DEFAULT 'عمومی' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'mid' NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"assignee_admin_id" uuid,
	"first_reply_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_conversation_id_unique" UNIQUE("conversation_id")
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_profile_id" uuid NOT NULL,
	"engineer_profile_id" uuid NOT NULL,
	"type_name" varchar(80) NOT NULL,
	"duration" varchar(30),
	"price" bigint NOT NULL,
	"day" date NOT NULL,
	"slot" varchar(10) NOT NULL,
	"address" text NOT NULL,
	"note" text,
	"status" "visit_status" DEFAULT 'requested' NOT NULL,
	"decline_reason" text,
	"checklist" jsonb,
	"report" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "broadcast_id" uuid;--> statement-breakpoint
ALTER TABLE "app_config" ADD CONSTRAINT "app_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arbiter_payouts" ADD CONSTRAINT "arbiter_payouts_arbiter_id_arbiters_id_fk" FOREIGN KEY ("arbiter_id") REFERENCES "public"."arbiters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arbiter_payouts" ADD CONSTRAINT "arbiter_payouts_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_member_id_crew_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."crew_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_progress" ADD CONSTRAINT "course_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_owner_profile_id_profiles_id_fk" FOREIGN KEY ("owner_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_member_profile_id_profiles_id_fk" FOREIGN KEY ("member_profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_admin_id_admins_id_fk" FOREIGN KEY ("assignee_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_client_profile_id_profiles_id_fk" FOREIGN KEY ("client_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_engineer_profile_id_profiles_id_fk" FOREIGN KEY ("engineer_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crew_owner_idx" ON "crew_members" USING btree ("owner_profile_id");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "support_tickets" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "visits_engineer_idx" ON "visits" USING btree ("engineer_profile_id","day");--> statement-breakpoint
CREATE INDEX "visits_client_idx" ON "visits" USING btree ("client_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visits_slot_uq" ON "visits" USING btree ("engineer_profile_id","day","slot") WHERE status in ('requested', 'confirmed');