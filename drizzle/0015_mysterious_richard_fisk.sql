CREATE TABLE "site_visits" (
	"day" date NOT NULL,
	"visitor" varchar(40) NOT NULL,
	"user_id" uuid,
	"views" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_visits_day_visitor_pk" PRIMARY KEY("day","visitor")
);
--> statement-breakpoint
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_visits_day_idx" ON "site_visits" USING btree ("day");