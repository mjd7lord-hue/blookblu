ALTER TABLE "site_visits" ADD COLUMN "device" varchar(10);--> statement-breakpoint
ALTER TABLE "site_visits" ADD COLUMN "os" varchar(12);--> statement-breakpoint
ALTER TABLE "site_visits" ADD COLUMN "browser" varchar(12);--> statement-breakpoint
ALTER TABLE "site_visits" ADD COLUMN "source" varchar(40);--> statement-breakpoint
ALTER TABLE "site_visits" ADD COLUMN "installed" boolean DEFAULT false NOT NULL;