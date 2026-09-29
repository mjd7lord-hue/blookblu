CREATE TYPE "public"."admin_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "admin_roles" (
	"key" varchar(20) PRIMARY KEY NOT NULL,
	"name" varchar(40) NOT NULL,
	"color" varchar(12) DEFAULT '#888888' NOT NULL,
	"perms" jsonb NOT NULL,
	"fixed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_key" varchar(20) NOT NULL,
	"name" varchar(80) NOT NULL,
	"provinces" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "admin_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_role_key_admin_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."admin_roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admins_role_idx" ON "admins" USING btree ("role_key");
--> statement-breakpoint
-- نقش‌های پیش‌فرض (هم‌تراز با AROLES پنل ادمین)
INSERT INTO "admin_roles" ("key","name","color","perms","fixed") VALUES
('owner','مدیر ارشد','#F97316','{"dash": 2, "users": 2, "kyc": 2, "ads": 2, "chats": 2, "support": 2, "reports": 2, "qa": 2, "projects": 2, "pay": 2, "disputes": 2, "arbiters": 2, "guar": 2, "score": 2, "notif": 2, "stories": 2, "academy": 2, "catalog": 2, "legal": 2, "coefs": 2, "settings": 2, "status": 2, "admins": 2, "audit": 2}'::jsonb,true),
('content','ناظر محتوا','#0F9C88','{"dash": 1, "users": 1, "kyc": 0, "ads": 2, "chats": 2, "support": 0, "reports": 2, "qa": 2, "projects": 0, "pay": 0, "disputes": 0, "arbiters": 0, "guar": 0, "score": 0, "notif": 0, "stories": 2, "academy": 2, "catalog": 1, "legal": 0, "coefs": 0, "settings": 0, "status": 0, "admins": 0, "audit": 1}'::jsonb,false),
('support','پشتیبان','#5EA8FF','{"dash": 1, "users": 1, "kyc": 1, "ads": 0, "chats": 1, "support": 2, "reports": 0, "qa": 0, "projects": 1, "pay": 0, "disputes": 0, "arbiters": 0, "guar": 0, "score": 0, "notif": 1, "stories": 0, "academy": 0, "catalog": 0, "legal": 0, "coefs": 0, "settings": 0, "status": 0, "admins": 0, "audit": 0}'::jsonb,false),
('finance','مالی','#A98CFF','{"dash": 1, "users": 1, "kyc": 0, "ads": 0, "chats": 0, "support": 0, "reports": 0, "qa": 0, "projects": 2, "pay": 2, "disputes": 1, "arbiters": 0, "guar": 0, "score": 0, "notif": 0, "stories": 0, "academy": 0, "catalog": 0, "legal": 0, "coefs": 1, "settings": 0, "status": 0, "admins": 0, "audit": 1}'::jsonb,false),
('arbit','مسئول داوری','#FB7185','{"dash": 1, "users": 1, "kyc": 0, "ads": 0, "chats": 1, "support": 0, "reports": 0, "qa": 0, "projects": 1, "pay": 0, "disputes": 2, "arbiters": 2, "guar": 0, "score": 0, "notif": 0, "stories": 0, "academy": 0, "catalog": 0, "legal": 1, "coefs": 1, "settings": 0, "status": 0, "admins": 0, "audit": 0}'::jsonb,false),
('kyc','کارشناس احراز','#22D3EE','{"dash": 1, "users": 2, "kyc": 2, "ads": 0, "chats": 0, "support": 0, "reports": 0, "qa": 0, "projects": 0, "pay": 0, "disputes": 0, "arbiters": 0, "guar": 2, "score": 1, "notif": 0, "stories": 0, "academy": 0, "catalog": 0, "legal": 0, "coefs": 0, "settings": 0, "status": 0, "admins": 0, "audit": 0}'::jsonb,false)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- ادمین‌های فعلی (users.is_admin) ← مدیر ارشد
INSERT INTO "admins" ("user_id","role_key","name")
SELECT u.id, 'owner', coalesce(nullif(trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')), ''), u.phone)
FROM "users" u WHERE u.is_admin = true AND u.status <> 'deleted'
ON CONFLICT ("user_id") DO NOTHING;
