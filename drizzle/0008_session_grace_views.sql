CREATE TABLE "view_days" (
	"kind" varchar(8) NOT NULL,
	"item_id" uuid NOT NULL,
	"day" date NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "view_days_kind_item_id_day_pk" PRIMARY KEY("kind","item_id","day")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "views" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "replaced_at" timestamp with time zone;