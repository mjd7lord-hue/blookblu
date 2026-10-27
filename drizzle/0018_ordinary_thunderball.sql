CREATE TABLE "founders" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"followed_at" timestamp with time zone,
	"number" smallint,
	"assigned_at" timestamp with time zone,
	"commission_free_until" timestamp with time zone,
	"manual" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "founders" ADD CONSTRAINT "founders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founders_number_uq" ON "founders" USING btree ("number");